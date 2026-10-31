import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { z } from "zod";

/**
 * Thin client for the Jupiter Swap API (v1).
 * Docs: https://dev.jup.ag/docs/swap-api
 *
 * We use /quote to find the best route and /swap-instructions (not /swap) so we can
 * assemble the transaction ourselves: that is what lets us set our sponsor as fee payer
 * and control compute budget / priority fees.
 */

const quoteSchema = z
  .object({
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: z.string(),
    outAmount: z.string(),
    otherAmountThreshold: z.string(),
    swapMode: z.string(),
    slippageBps: z.number(),
    priceImpactPct: z.string(),
    platformFee: z.object({ amount: z.string(), feeBps: z.number() }).nullable().optional(),
    routePlan: z.array(z.unknown()),
  })
  .passthrough();

export type JupiterQuote = z.infer<typeof quoteSchema>;

const ixSchema = z.object({
  programId: z.string(),
  accounts: z.array(z.object({ pubkey: z.string(), isSigner: z.boolean(), isWritable: z.boolean() })),
  data: z.string(),
});

const swapIxSchema = z.object({
  computeBudgetInstructions: z.array(ixSchema).default([]),
  setupInstructions: z.array(ixSchema).default([]),
  swapInstruction: ixSchema,
  cleanupInstruction: ixSchema.nullable().optional(),
  otherInstructions: z.array(ixSchema).default([]),
  addressLookupTableAddresses: z.array(z.string()).default([]),
});

export type JupiterSwapInstructions = {
  computeBudget: TransactionInstruction[];
  setup: TransactionInstruction[];
  swap: TransactionInstruction;
  cleanup: TransactionInstruction[];
  other: TransactionInstruction[];
  lookupTables: PublicKey[];
};

export class JupiterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export type QuoteParams = {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  platformFeeBps: number;
};

export type FetchLike = typeof fetch;

export type JupiterClientOptions = {
  timeoutMs?: number;
  /** Optional key for Jupiter's keyed API (higher rate limits); sent as `x-api-key`. */
  apiKey?: string;
  sleep?: (ms: number) => Promise<void>;
};

export class JupiterClient {
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly opts: JupiterClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.sleep = opts.sleep ?? sleep;
  }

  async quote(p: QuoteParams): Promise<JupiterQuote> {
    const qs = new URLSearchParams({
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      amount: p.amount.toString(),
      slippageBps: String(p.slippageBps),
      platformFeeBps: String(p.platformFeeBps),
      // keep transactions small enough to always fit with our extra instructions
      maxAccounts: "54",
    });
    const json = await this.request(`${this.baseUrl}/quote?${qs}`);
    return quoteSchema.parse(json);
  }

  async swapInstructions(args: {
    quote: JupiterQuote;
    userPublicKey: string;
    feeAccount?: string;
  }): Promise<JupiterSwapInstructions> {
    const json = await this.request(`${this.baseUrl}/swap-instructions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse: args.quote,
        userPublicKey: args.userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        feeAccount: args.feeAccount,
        // We set priority fees ourselves so the sponsor's spend is capped.
        prioritizationFeeLamports: 0,
      }),
    });
    const parsed = swapIxSchema.parse(json);
    return {
      computeBudget: parsed.computeBudgetInstructions.map(toIx),
      setup: parsed.setupInstructions.map(toIx),
      swap: toIx(parsed.swapInstruction),
      cleanup: parsed.cleanupInstruction ? [toIx(parsed.cleanupInstruction)] : [],
      other: parsed.otherInstructions.map(toIx),
      lookupTables: parsed.addressLookupTableAddresses.map((a) => new PublicKey(a)),
    };
  }

  private async request(url: string, init?: RequestInit, attempt = 0): Promise<unknown> {
    const maxAttempts = 3;
    const headers = new Headers(init?.headers);
    if (this.opts.apiKey) headers.set("x-api-key", this.opts.apiKey);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      if (attempt + 1 < maxAttempts) {
        await this.sleep(backoffMs(attempt));
        return this.request(url, init, attempt + 1);
      }
      throw new JupiterError(`Jupiter request failed: ${(err as Error).message}`, undefined, true);
    }
    if (res.ok) return res.json();

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt + 1 < maxAttempts) {
      await this.sleep(res.status === 429 ? rateLimitBackoffMs(attempt, res.headers.get("retry-after")) : backoffMs(attempt));
      return this.request(url, init, attempt + 1);
    }
    const body = await res.text().catch(() => "");
    throw new JupiterError(`Jupiter ${res.status}: ${body.slice(0, 300)}`, res.status, retryable);
  }
}

/** Rate-limit windows are about a second or more, so short exponential backoff just burns retries. */
export function rateLimitBackoffMs(attempt: number, retryAfter: string | null): number {
  const hinted = retryAfter ? Number(retryAfter) * 1_000 : NaN;
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted, 5_000);
  return 1_000 * 2 ** attempt + Math.floor(Math.random() * 250);
}

function toIx(ix: z.infer<typeof ixSchema>): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map(
      (a): AccountMeta => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable }),
    ),
    data: Buffer.from(ix.data, "base64"),
  });
}

const backoffMs = (attempt: number) => 200 * 2 ** attempt + Math.floor(Math.random() * 100);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
