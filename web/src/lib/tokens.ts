export type Token = {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  color: string;
};

export const TOKENS: Token[] = [
  { symbol: "SOL", name: "Solana", mint: "So11111111111111111111111111111111111111112", decimals: 9, color: "#9945FF" },
  { symbol: "USDC", name: "USD Coin", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, color: "#2775CA" },
  { symbol: "JUP", name: "Jupiter", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", decimals: 6, color: "#14F195" },
];

export const tokenByMint = (mint: string) => TOKENS.find((t) => t.mint === mint);

/** "1.5" with 9 decimals -> "1500000000". String math so we never round through floats. */
export function toBaseUnits(amount: string, decimals: number): string | null {
  const trimmed = amount.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
  const [whole = "", frac = ""] = trimmed.split(".");
  if (frac.length > decimals) return null;
  const base = BigInt((whole || "0") + frac.padEnd(decimals, "0"));
  return base > 0n ? base.toString() : null;
}

/** "1500000000" with 9 decimals -> "1.5" (trailing zeros trimmed, capped to `maxFraction`). */
export function fromBaseUnits(base: string, decimals: number, maxFraction = 6): string {
  const value = BigInt(base);
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const frac = (value % divisor).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  return frac ? `${whole.toLocaleString("en-US")}.${frac}` : whole.toLocaleString("en-US");
}

export const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
