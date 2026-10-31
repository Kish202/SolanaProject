export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
export const WS_URL = API_URL.replace(/^http/, "ws");

export type PriceTick = { mint: string; usd: number; ts: number; change24h: number | null };

export type QuotePreview = {
  inAmount: string;
  outAmount: string;
  minOutAmount: string;
  priceImpactPct: string;
  platformFeeBps: number;
  platformFeeAmount: string;
  routeHops: number;
};

export type BuiltTrade = {
  tradeId: string;
  transaction: string;
  lastValidBlockHeight: number;
  quote: Omit<QuotePreview, "routeHops">;
  gas: { sponsored: boolean; computeUnitLimit: number; priorityFeeLamports: string };
};

export type TradeStatus = "built" | "submitted" | "confirmed" | "failed" | "expired";

export type Trade = {
  id: string;
  input_mint: string;
  output_mint: string;
  in_amount: string;
  quoted_out_amount: string;
  platform_fee_amount: string;
  status: TradeStatus;
  signature: string | null;
  network_fee_lamports: string | null;
  error: string | null;
  created_at: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      body.message ?? (body.error === "validation" ? "Invalid input" : `Request failed (${res.status})`);
    throw new ApiError(message, body.error ?? "unknown", res.status);
  }
  return body as T;
}

export const api = {
  health: () => request<{ ok: boolean }>("/readyz"),
  prices: () => request<{ prices: PriceTick[] }>("/v1/prices"),
  preview: (p: { inputMint: string; outputMint: string; amount: string; slippageBps: number }) =>
    request<QuotePreview>(`/v1/quotes/preview?${new URLSearchParams({ ...p, slippageBps: String(p.slippageBps) })}`),
  buildTrade: (p: { wallet: string; inputMint: string; outputMint: string; amount: string; slippageBps: number }) =>
    request<BuiltTrade>("/v1/trades/quote", { method: "POST", body: JSON.stringify(p) }),
  submit: (tradeId: string, signedTransaction: string) =>
    request<{ tradeId: string; signature: string; status: TradeStatus }>(`/v1/trades/${tradeId}/submit`, {
      method: "POST",
      body: JSON.stringify({ signedTransaction }),
    }),
  trade: (id: string) => request<Trade>(`/v1/trades/${id}`),
  trades: (wallet: string) => request<{ trades: Trade[] }>(`/v1/trades?wallet=${wallet}`),
};

export const base64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export const bytesToBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));

export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;
