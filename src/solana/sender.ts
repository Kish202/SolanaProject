import type { Commitment, SignatureStatus, TransactionError } from "@solana/web3.js";
import { rpcErrors, txRebroadcasts } from "../metrics.js";

/**
 * Lands a signed transaction and tells us exactly what happened.
 *
 * Why not just `sendAndConfirmTransaction`?
 *  - RPC nodes drop transactions under load; the leader may never see a single send.
 *    We rebroadcast the *same signed bytes* on an interval until it lands or expires.
 *    Re-sending identical bytes is safe: a signature can only ever be processed once.
 *  - A transaction is only valid until `lastValidBlockHeight` (~60-90s after its blockhash).
 *    Once the chain passes that height it can NEVER land, so we can report "expired" with
 *    certainty — which is what makes it safe for the client to rebuild and retry.
 *    Retrying before that point could double-execute the trade.
 */

export interface SenderRpc {
  sendRawTransaction(raw: Uint8Array, opts: { skipPreflight: boolean; maxRetries: number }): Promise<string>;
  getSignatureStatuses(
    sigs: string[],
    opts?: { searchTransactionHistory: boolean },
  ): Promise<{ value: (SignatureStatus | null)[] }>;
  getBlockHeight(commitment?: Commitment): Promise<number>;
}

export type LandingResult =
  | { status: "confirmed"; signature: string; slot: number; elapsedMs: number; rebroadcasts: number }
  | { status: "failed"; signature: string; slot: number; err: TransactionError; elapsedMs: number; rebroadcasts: number }
  | { status: "expired"; signature: string; elapsedMs: number; rebroadcasts: number };

export type SendOptions = {
  signature: string;
  rawTx: Uint8Array;
  lastValidBlockHeight: number;
  /** Primary RPC used for status/block height polling. */
  rpc: SenderRpc;
  /** Extra RPCs to fan the send out to (e.g. a staked-connection provider). */
  broadcastRpcs?: SenderRpc[];
  commitment?: "confirmed" | "finalized";
  pollIntervalMs?: number;
  rebroadcastIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function sendAndConfirm(opts: SendOptions): Promise<LandingResult> {
  const {
    signature,
    rawTx,
    lastValidBlockHeight,
    rpc,
    broadcastRpcs = [],
    commitment = "confirmed",
    pollIntervalMs = 500,
    rebroadcastIntervalMs = 2_000,
    now = Date.now,
    sleep = defaultSleep,
  } = opts;

  const targets = [rpc, ...broadcastRpcs];
  const started = now();
  let lastBroadcast = 0;
  let rebroadcasts = 0;

  const broadcast = async () => {
    await Promise.allSettled(
      targets.map((t) =>
        t.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 }).catch((err: Error) => {
          // "already processed" means it landed — the status poll will pick it up.
          if (!/already been processed/i.test(err.message)) rpcErrors.inc({ method: "sendRawTransaction" });
          throw err;
        }),
      ),
    );
    lastBroadcast = now();
  };

  await broadcast();

  for (;;) {
    const status = await checkStatus(rpc, signature, false);
    if (status) {
      const landed = toResult(status, signature, commitment, now() - started, rebroadcasts);
      if (landed) return landed;
    }

    let height: number | undefined;
    try {
      height = await rpc.getBlockHeight("confirmed");
    } catch {
      rpcErrors.inc({ method: "getBlockHeight" });
    }

    if (height !== undefined && height > lastValidBlockHeight) {
      // The blockhash is dead. Do one last history lookup in case it landed right at the edge.
      const final = await checkStatus(rpc, signature, true);
      const landed = final && toResult(final, signature, "confirmed", now() - started, rebroadcasts);
      if (landed) return landed;
      return { status: "expired", signature, elapsedMs: now() - started, rebroadcasts };
    }

    if (now() - lastBroadcast >= rebroadcastIntervalMs) {
      rebroadcasts++;
      txRebroadcasts.inc();
      await broadcast();
    }
    await sleep(pollIntervalMs);
  }
}

async function checkStatus(rpc: SenderRpc, signature: string, history: boolean): Promise<SignatureStatus | null> {
  try {
    const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: history });
    return value[0] ?? null;
  } catch {
    rpcErrors.inc({ method: "getSignatureStatuses" });
    return null;
  }
}

function toResult(
  s: SignatureStatus,
  signature: string,
  commitment: "confirmed" | "finalized",
  elapsedMs: number,
  rebroadcasts: number,
): LandingResult | null {
  if (s.err) return { status: "failed", signature, slot: s.slot, err: s.err, elapsedMs, rebroadcasts };
  const reached =
    commitment === "confirmed"
      ? s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized"
      : s.confirmationStatus === "finalized";
  return reached ? { status: "confirmed", signature, slot: s.slot, elapsedMs, rebroadcasts } : null;
}
