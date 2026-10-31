import { randomUUID } from "node:crypto";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import type { Db } from "../db/pool.js";
import { withTransaction } from "../db/pool.js";
import type { Logger } from "../logger.js";
import { journalsForTrade } from "../ledger/journal.js";
import { writeJournals } from "../ledger/ledgerRepo.js";
import { sponsorSpendLamports, txLandingSeconds, txOutcomes } from "../metrics.js";
import type { JupiterClient } from "../solana/jupiter.js";
import { sendAndConfirm, type LandingResult, type SenderRpc } from "../solana/sender.js";
import { priorityFeeLamports } from "../solana/sponsorPolicy.js";
import { buildSponsoredSwapTx } from "../solana/txBuilder.js";
import { verifyUserSignedTx } from "../solana/verify.js";
import type { SponsorGuard } from "./sponsorGuard.js";

const BASE_FEE_PER_SIGNATURE = 5_000n;

export class TradeError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 400,
    readonly code = "bad_request",
  ) {
    super(message);
  }
}

export type QuoteRequest = {
  wallet: string;
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  creatorId?: string;
};

type TradeRow = {
  id: string;
  wallet: string;
  creator_id: string | null;
  status: string;
  message_hash: string;
  last_valid_block_height: string;
  signature: string | null;
  signed_tx: string | null;
  platform_fee_mint: string | null;
  platform_fee_amount: string;
};

const PREVIEW_TTL_MS = 5_000;

export type PreviewResult = {
  inAmount: string;
  outAmount: string;
  minOutAmount: string;
  priceImpactPct: string;
  platformFeeBps: number;
  platformFeeAmount: string;
  routeHops: number;
};

export class TradeService {
  private readonly feeAccountCache = new Map<string, PublicKey | null>();

  constructor(
    private readonly deps: {
      db: Db;
      connection: Connection;
      broadcastRpcs: SenderRpc[];
      jupiter: JupiterClient;
      sponsor: Keypair;
      guard: SponsorGuard;
      log: Logger;
      platformFeeBps: number;
      platformFeeOwner: PublicKey;
      maxPriorityFeeLamports: number;
    },
  ) {}

  private readonly previewCache = new Map<string, { at: number; value: Promise<PreviewResult> }>();

  /** Identical previews within PREVIEW_TTL_MS share one Jupiter call, to stay inside its rate limit. */
  preview(req: Omit<QuoteRequest, "wallet" | "creatorId">): Promise<PreviewResult> {
    if (req.inputMint === req.outputMint) throw new TradeError("inputMint and outputMint must differ");
    const key = `${req.inputMint}:${req.outputMint}:${req.amount}:${req.slippageBps}`;
    const now = Date.now();
    const hit = this.previewCache.get(key);
    if (hit && now - hit.at < PREVIEW_TTL_MS) return hit.value;
    for (const [k, v] of this.previewCache) if (now - v.at >= PREVIEW_TTL_MS) this.previewCache.delete(k);
    const value = this.fetchPreview(req);
    value.catch(() => this.previewCache.delete(key));
    this.previewCache.set(key, { at: now, value });
    return value;
  }

  private async fetchPreview(req: Omit<QuoteRequest, "wallet" | "creatorId">) {
    const platformFeeBps = (await this.feeAccountFor(req.outputMint)) ? this.deps.platformFeeBps : 0;
    const quote = await this.deps.jupiter.quote({ ...req, platformFeeBps });
    return {
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      minOutAmount: quote.otherAmountThreshold,
      priceImpactPct: quote.priceImpactPct,
      platformFeeBps,
      platformFeeAmount: quote.platformFee?.amount ?? "0",
      routeHops: quote.routePlan.length,
    };
  }

  async listByWallet(wallet: string) {
    const { rows } = await this.deps.db.query(
      `SELECT id, input_mint, output_mint, in_amount, quoted_out_amount, platform_fee_amount,
              status, signature, network_fee_lamports, error, created_at
         FROM trades WHERE wallet = $1 AND status <> 'built'
        ORDER BY created_at DESC LIMIT 20`,
      [wallet],
    );
    return rows;
  }

  /** Step 1: route through Jupiter and build a sponsor-paid transaction for the user to sign. */
  async quote(req: QuoteRequest) {
    const { db, connection, jupiter, sponsor, guard } = this.deps;
    const user = parsePubkey(req.wallet, "wallet");
    if (req.inputMint === req.outputMint) throw new TradeError("inputMint and outputMint must differ");

    const creator = req.creatorId ? await this.loadCreator(req.creatorId) : null;
    if (req.creatorId && !creator) throw new TradeError("unknown creator", 404, "unknown_creator");

    // ExactIn swaps take the platform fee in the output mint. If we have no fee account
    // for that mint yet, quote without a fee rather than failing the user's trade.
    const feeAccount = await this.feeAccountFor(req.outputMint);
    const platformFeeBps = feeAccount ? this.deps.platformFeeBps : 0;

    await guard.reserve(req.wallet, BigInt(this.deps.maxPriorityFeeLamports) + 2n * BASE_FEE_PER_SIGNATURE);

    const quote = await jupiter.quote({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amount: req.amount,
      slippageBps: req.slippageBps,
      platformFeeBps,
    });
    const swap = await jupiter.swapInstructions({
      quote,
      userPublicKey: user.toBase58(),
      feeAccount: feeAccount?.toBase58(),
    });
    const built = await buildSponsoredSwapTx({
      connection,
      swap,
      sponsor: sponsor.publicKey,
      maxPriorityFeeLamports: this.deps.maxPriorityFeeLamports,
    });

    const id = randomUUID();
    const platformFeeAmount = quote.platformFee?.amount ?? "0";
    await db.query(
      `INSERT INTO trades (id, wallet, creator_id, input_mint, output_mint, in_amount, quoted_out_amount,
                           slippage_bps, platform_fee_bps, platform_fee_mint, platform_fee_amount,
                           message_hash, last_valid_block_height)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        id,
        req.wallet,
        creator?.id ?? null,
        req.inputMint,
        req.outputMint,
        quote.inAmount,
        quote.outAmount,
        req.slippageBps,
        platformFeeBps,
        feeAccount ? req.outputMint : null,
        platformFeeAmount,
        built.messageHash,
        built.lastValidBlockHeight,
      ],
    );

    return {
      tradeId: id,
      transaction: Buffer.from(built.tx.serialize()).toString("base64"),
      lastValidBlockHeight: built.lastValidBlockHeight,
      quote: {
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        minOutAmount: quote.otherAmountThreshold,
        priceImpactPct: quote.priceImpactPct,
        platformFeeBps,
        platformFeeAmount,
      },
      gas: {
        sponsored: true,
        computeUnitLimit: built.computeUnitLimit,
        priorityFeeLamports: priorityFeeLamports(built.computeUnitLimit, built.microLamportsPerCu).toString(),
      },
    };
  }

  /** Step 2: user returns the signed tx; we verify, co-sign as fee payer, and start landing it. */
  async submit(tradeId: string, signedTxBase64: string) {
    const { db, connection, sponsor, log } = this.deps;

    // Atomic state transition: only one submit per trade can ever proceed.
    const { rows } = await db.query<TradeRow>(
      `UPDATE trades SET status = 'submitted', updated_at = now()
        WHERE id = $1 AND status = 'built' RETURNING *`,
      [tradeId],
    );
    const trade = rows[0];
    if (!trade) throw new TradeError("trade not found or already submitted", 409, "invalid_state");

    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(signedTxBase64, "base64"));
      verifyUserSignedTx({
        tx,
        expectedMessageHash: trade.message_hash,
        sponsor: sponsor.publicKey,
        user: new PublicKey(trade.wallet),
      });
    } catch (err) {
      await this.markTerminal(tradeId, "failed", `rejected: ${(err as Error).message}`);
      throw new TradeError((err as Error).message, 400, "invalid_signed_tx");
    }

    // A failed tx still costs the sponsor its fee, so simulate before paying for it.
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
    if (sim.value.err) {
      await this.markTerminal(tradeId, "failed", `simulation: ${JSON.stringify(sim.value.err)}`);
      throw new TradeError("transaction simulation failed", 422, "simulation_failed");
    }

    tx.sign([sponsor]);
    const firstSig = tx.signatures[0];
    if (!firstSig) throw new TradeError("missing fee payer signature", 500, "internal");
    const signature = bs58.encode(firstSig);
    const raw = Buffer.from(tx.serialize()).toString("base64");

    // Persist the signature BEFORE broadcasting: if we crash mid-send, recovery can still find it.
    await db.query("UPDATE trades SET signature = $2, signed_tx = $3, updated_at = now() WHERE id = $1", [
      tradeId,
      signature,
      raw,
    ]);

    void this.land({ ...trade, signature, signed_tx: raw }).catch((err) =>
      log.error({ err, tradeId }, "landing loop crashed; recovery will resume it"),
    );
    return { tradeId, signature, status: "submitted" as const };
  }

  async get(tradeId: string) {
    const { rows } = await this.deps.db.query(
      `SELECT id, wallet, creator_id, input_mint, output_mint, in_amount, quoted_out_amount, platform_fee_amount,
              status, signature, network_fee_lamports, error, created_at, updated_at
         FROM trades WHERE id = $1`,
      [tradeId],
    );
    return rows[0] ?? null;
  }

  /** On startup: resume landing for anything that was in flight when the process died. */
  async recoverInFlight(): Promise<number> {
    const { rows } = await this.deps.db.query<TradeRow>(
      "SELECT * FROM trades WHERE status = 'submitted' AND signature IS NOT NULL",
    );
    for (const t of rows) void this.land(t).catch((err) => this.deps.log.error({ err, tradeId: t.id }, "recovery failed"));
    await this.deps.db.query(
      `UPDATE trades SET status = 'expired', error = 'never signed by sponsor', updated_at = now()
        WHERE status = 'submitted' AND signature IS NULL`,
    );
    return rows.length;
  }

  private async land(trade: TradeRow): Promise<void> {
    if (!trade.signature || !trade.signed_tx) return;
    const result = await sendAndConfirm({
      signature: trade.signature,
      rawTx: Buffer.from(trade.signed_tx, "base64"),
      lastValidBlockHeight: Number(trade.last_valid_block_height),
      rpc: this.deps.connection,
      broadcastRpcs: this.deps.broadcastRpcs,
    });
    await this.settle(trade, result);
  }

  private async settle(trade: TradeRow, result: LandingResult): Promise<void> {
    const { db, log, guard } = this.deps;
    txOutcomes.inc({ outcome: result.status });
    log.info({ event: "trade_landed", tradeId: trade.id, ...result }, "trade landed");

    if (result.status === "expired") {
      await this.markTerminal(trade.id, "expired", "blockhash expired before landing");
      return;
    }

    txLandingSeconds.observe(result.elapsedMs / 1000);
    const networkFee = await this.networkFee(result.signature, trade.signed_tx);
    sponsorSpendLamports.inc(Number(networkFee));
    await guard.recordSpend(networkFee);

    const creator = trade.creator_id ? await this.loadCreator(trade.creator_id) : null;
    const journals = journalsForTrade({
      status: result.status,
      networkFeeLamports: networkFee,
      platformFeeMint: trade.platform_fee_mint,
      platformFeeAmount: BigInt(trade.platform_fee_amount),
      creator: creator ? { id: creator.id, commissionBps: creator.commission_bps } : null,
    });

    await withTransaction(db, async (client) => {
      await client.query(
        `UPDATE trades SET status = $2, network_fee_lamports = $3, error = $4, updated_at = now()
          WHERE id = $1 AND status = 'submitted'`,
        [trade.id, result.status, networkFee.toString(), result.status === "failed" ? JSON.stringify(result.err) : null],
      );
      await writeJournals(client, trade.id, journals);
    });
  }

  /** Actual fee from chain; fall back to an estimate if the RPC hasn't indexed the tx yet. */
  private async networkFee(signature: string, signedTx: string | null): Promise<bigint> {
    try {
      const tx = await this.deps.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (tx?.meta) return BigInt(tx.meta.fee);
    } catch {
      // fall through to estimate
    }
    const sigCount = signedTx ? VersionedTransaction.deserialize(Buffer.from(signedTx, "base64")).signatures.length : 2;
    return BigInt(sigCount) * BASE_FEE_PER_SIGNATURE + BigInt(this.deps.maxPriorityFeeLamports);
  }

  private async markTerminal(id: string, status: "failed" | "expired", error: string) {
    await this.deps.db.query(
      "UPDATE trades SET status = $2, error = $3, updated_at = now() WHERE id = $1 AND status IN ('built','submitted')",
      [id, status, error],
    );
  }

  private async loadCreator(id: string) {
    const { rows } = await this.deps.db.query<{ id: string; commission_bps: number }>(
      "SELECT id, commission_bps FROM creators WHERE id = $1",
      [id],
    );
    return rows[0] ?? null;
  }

  private async feeAccountFor(mint: string): Promise<PublicKey | null> {
    if (this.feeAccountCache.has(mint)) return this.feeAccountCache.get(mint) ?? null;
    const mintKey = parsePubkey(mint, "mint");
    let found: PublicKey | null = null;
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const ata = getAssociatedTokenAddressSync(mintKey, this.deps.platformFeeOwner, true, programId);
      if (await this.deps.connection.getAccountInfo(ata)) {
        found = ata;
        break;
      }
    }
    if (found) this.feeAccountCache.set(mint, found);
    return found;
  }
}

function parsePubkey(value: string, field: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new TradeError(`${field} is not a valid public key`);
  }
}
