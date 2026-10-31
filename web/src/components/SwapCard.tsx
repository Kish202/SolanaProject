"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { VersionedTransaction } from "@solana/web3.js";
import { api, ApiError, base64ToBytes, bytesToBase64, solscanTx, type QuotePreview, type TradeStatus } from "@/lib/api";
import { fromBaseUnits, toBaseUnits, TOKENS, type Token } from "@/lib/tokens";
import type { LivePrice } from "@/hooks/usePrices";
import { TokenBadge } from "./TokenBadge";

type Step = "idle" | "building" | "signing" | "submitting" | "landing" | TradeStatus;

const SLIPPAGE_OPTIONS = [10, 50, 100];

export function SwapCard({ prices, onTradeSettled }: { prices: Record<string, LivePrice>; onTradeSettled: () => void }) {
  const { publicKey, signTransaction, connected } = useWallet();
  const { setVisible } = useWalletModal();

  const [from, setFrom] = useState<Token>(TOKENS[0]!);
  const [to, setTo] = useState<Token>(TOKENS[1]!);
  const [amount, setAmount] = useState("0.01");
  const [slippageBps, setSlippageBps] = useState(50);
  const [quoteState, setQuoteState] = useState<{ key: string; preview: QuotePreview | null; error: string | null }>({
    key: "",
    preview: null,
    error: null,
  });
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

  const baseAmount = useMemo(() => toBaseUnits(amount, from.decimals), [amount, from.decimals]);
  const busy = ["building", "signing", "submitting", "landing"].includes(step);

  // Results are tagged with the inputs they were fetched for, so stale quotes are never shown.
  const quoteKey = baseAmount ? `${from.mint}|${to.mint}|${baseAmount}|${slippageBps}` : "";
  const fresh = quoteState.key === quoteKey && quoteKey !== "";
  const preview = fresh ? quoteState.preview : null;
  const previewError = fresh ? quoteState.error : null;
  const loadingPreview = quoteKey !== "" && !fresh;

  // Debounced read-only quote that refreshes every 15s so the displayed price stays fresh.
  useEffect(() => {
    if (!baseAmount) return;
    const key = `${from.mint}|${to.mint}|${baseAmount}|${slippageBps}`;
    let cancelled = false;
    const load = async () => {
      try {
        const q = await api.preview({ inputMint: from.mint, outputMint: to.mint, amount: baseAmount, slippageBps });
        if (!cancelled) setQuoteState({ key, preview: q, error: null });
      } catch (e) {
        if (!cancelled) setQuoteState({ key, preview: null, error: e instanceof Error ? e.message : "Could not fetch quote" });
      }
    };
    const debounce = setTimeout(load, 400);
    const refresh = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearTimeout(debounce);
      clearInterval(refresh);
    };
  }, [baseAmount, from.mint, to.mint, slippageBps]);

  const flip = () => {
    setFrom(to);
    setTo(from);
    if (preview) setAmount(fromBaseUnits(preview.outAmount, to.decimals, to.decimals).replace(/,/g, ""));
  };

  const pickToken = (side: "from" | "to", t: Token) => {
    if (side === "from") {
      if (t.mint === to.mint) setTo(from);
      setFrom(t);
    } else {
      if (t.mint === from.mint) setFrom(to);
      setTo(t);
    }
  };

  const swap = useCallback(async () => {
    if (!publicKey || !signTransaction || !baseAmount) return;
    setError(null);
    setSignature(null);
    try {
      setStep("building");
      const built = await api.buildTrade({
        wallet: publicKey.toBase58(),
        inputMint: from.mint,
        outputMint: to.mint,
        amount: baseAmount,
        slippageBps,
      });

      setStep("signing");
      const tx = VersionedTransaction.deserialize(base64ToBytes(built.transaction));
      const signed = await signTransaction(tx);

      setStep("submitting");
      const sub = await api.submit(built.tradeId, bytesToBase64(signed.serialize()));
      setSignature(sub.signature);

      setStep("landing");
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 1_500));
        const t = await api.trade(built.tradeId);
        if (t.status !== "submitted" && t.status !== "built") {
          setStep(t.status);
          if (t.status !== "confirmed") setError(t.error ?? `Trade ${t.status}`);
          onTradeSettled();
          return;
        }
      }
      setError("Still waiting for confirmation. Check the explorer link.");
      setStep("idle");
    } catch (e) {
      const msg =
        e instanceof ApiError ? e.message : e instanceof Error && /reject/i.test(e.message) ? "You rejected the request in your wallet" : String((e as Error)?.message ?? e);
      setError(msg);
      setStep("idle");
    }
  }, [publicKey, signTransaction, baseAmount, from.mint, to.mint, slippageBps, onTradeSettled]);

  const fromUsd = prices[from.mint] && baseAmount ? Number(amount) * prices[from.mint]!.usd : null;
  const toUsd =
    prices[to.mint] && preview ? (Number(preview.outAmount) / 10 ** to.decimals) * prices[to.mint]!.usd : null;

  const buttonLabel = !connected
    ? "Connect wallet"
    : !baseAmount
      ? "Enter an amount"
      : {
          building: "Building transaction…",
          signing: "Approve in your wallet…",
          submitting: "Submitting…",
          landing: "Landing on Solana…",
        }[step as string] ?? (previewError ? "No route available" : "Swap (gas free)");

  return (
    <section className="w-full rounded-3xl border border-white/10 bg-white/[0.03] p-5 shadow-2xl shadow-purple-950/30 backdrop-blur sm:p-6">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Swap</h2>
        <div className="flex items-center gap-1 rounded-full bg-white/5 p-1 text-xs">
          <span className="px-2 text-white/50">Slippage</span>
          {SLIPPAGE_OPTIONS.map((bps) => (
            <button
              key={bps}
              onClick={() => setSlippageBps(bps)}
              className={`rounded-full px-3 py-1 transition ${slippageBps === bps ? "bg-white/15 text-white" : "text-white/50 hover:text-white"}`}
            >
              {bps / 100}%
            </button>
          ))}
        </div>
      </div>

      <TokenField
        label="You pay"
        token={from}
        onToken={(t) => pickToken("from", t)}
        usd={fromUsd}
        input={
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(",", "."))}
            placeholder="0.0"
            className="w-full min-w-0 bg-transparent text-3xl font-semibold outline-none placeholder:text-white/20"
          />
        }
      />

      <div className="relative z-10 -my-3 flex justify-center">
        <button
          onClick={flip}
          aria-label="Flip tokens"
          className="rounded-xl border border-white/10 bg-[#12101c] p-2 text-white/70 transition hover:rotate-180 hover:text-white"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M7 4v16M7 20l-4-4M7 20l4-4M17 20V4M17 4l-4 4M17 4l4 4" />
          </svg>
        </button>
      </div>

      <TokenField
        label="You receive"
        token={to}
        onToken={(t) => pickToken("to", t)}
        usd={toUsd}
        input={
          <div className={`text-3xl font-semibold ${loadingPreview ? "animate-pulse text-white/40" : ""}`}>
            {preview ? fromBaseUnits(preview.outAmount, to.decimals) : <span className="text-white/20">0.0</span>}
          </div>
        }
      />

      <dl className="mt-4 space-y-2 rounded-2xl bg-black/20 p-4 text-sm">
        <Row label="Rate">
          {preview && baseAmount
            ? `1 ${from.symbol} ≈ ${(Number(preview.outAmount) / 10 ** to.decimals / (Number(baseAmount) / 10 ** from.decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${to.symbol}`
            : "—"}
        </Row>
        <Row label="Minimum received">{preview ? `${fromBaseUnits(preview.minOutAmount, to.decimals)} ${to.symbol}` : "—"}</Row>
        <Row label="Price impact">{preview ? `${(Number(preview.priceImpactPct) * 100).toFixed(3)}%` : "—"}</Row>
        <Row label="Platform fee">{preview ? `${preview.platformFeeBps / 100}%` : "—"}</Row>
        <Row label="Route">{preview ? `Jupiter · ${preview.routeHops} hop${preview.routeHops === 1 ? "" : "s"}` : "—"}</Row>
        <Row label="Network fee">
          <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-xs font-medium text-emerald-300">Sponsored · $0.00</span>
        </Row>
      </dl>

      {previewError && <p className="mt-3 text-sm text-amber-300">{previewError}</p>}

      <button
        disabled={connected && (!baseAmount || busy || !!previewError)}
        onClick={connected ? swap : () => setVisible(true)}
        className="mt-5 w-full rounded-2xl bg-gradient-to-r from-[#9945FF] to-[#14F195] py-4 text-base font-semibold text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {buttonLabel}
      </button>

      {(step !== "idle" || error) && (
        <StatusPanel step={step} error={error} signature={signature} />
      )}
    </section>
  );
}

function TokenField({
  label,
  token,
  onToken,
  input,
  usd,
}: {
  label: string;
  token: Token;
  onToken: (t: Token) => void;
  input: React.ReactNode;
  usd: number | null;
}) {
  return (
    <div className="rounded-2xl border border-white/5 bg-black/30 p-4">
      <div className="mb-2 text-xs uppercase tracking-wider text-white/40">{label}</div>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">{input}</div>
        <select
          value={token.mint}
          onChange={(e) => onToken(TOKENS.find((t) => t.mint === e.target.value)!)}
          className="cursor-pointer rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold outline-none hover:bg-white/10"
        >
          {TOKENS.map((t) => (
            <option key={t.mint} value={t.mint} className="bg-[#12101c]">
              {t.symbol}
            </option>
          ))}
        </select>
        <TokenBadge token={token} />
      </div>
      <div className="mt-1 text-sm text-white/40">{usd !== null && Number.isFinite(usd) ? `≈ $${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "\u00a0"}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-white/50">{label}</dt>
      <dd className="text-right text-white/90">{children}</dd>
    </div>
  );
}

const STEPS: { key: Step; label: string }[] = [
  { key: "building", label: "Route & build" },
  { key: "signing", label: "Wallet signs" },
  { key: "submitting", label: "Sponsor co-signs" },
  { key: "landing", label: "Landing" },
  { key: "confirmed", label: "Confirmed" },
];

function StatusPanel({ step, error, signature }: { step: Step; error: string | null; signature: string | null }) {
  const terminal = step === "confirmed" || step === "failed" || step === "expired";
  const activeIndex = terminal ? 4 : STEPS.findIndex((s) => s.key === step);

  return (
    <div className="mt-4 rounded-2xl border border-white/10 bg-black/30 p-4 text-sm">
      {activeIndex >= 0 && (
        <ol className="grid grid-cols-5 gap-2">
          {STEPS.map((s, i) => {
            const done = i < activeIndex || step === "confirmed";
            const active = i === activeIndex && !terminal;
            const bad = terminal && step !== "confirmed" && i === 4;
            return (
              <li key={s.key} className="flex flex-col items-center gap-1 text-center">
                <span
                  className={`h-1.5 w-full rounded-full ${bad ? "bg-red-400" : done ? "bg-emerald-400" : active ? "animate-pulse bg-purple-400" : "bg-white/10"}`}
                />
                <span className={`text-[11px] ${done || active ? "text-white/80" : "text-white/30"}`}>
                  {bad ? (step === "expired" ? "Expired" : "Failed") : s.label}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {step === "confirmed" && <p className="mt-3 text-emerald-300">Swap confirmed on Solana mainnet.</p>}
      {step === "expired" && (
        <p className="mt-3 text-amber-300">The transaction expired before landing. Nothing was charged. Try again.</p>
      )}
      {error && step !== "expired" && <p className="mt-3 break-words text-red-300">{error}</p>}
      {signature && (
        <a href={solscanTx(signature)} target="_blank" rel="noreferrer" className="mt-2 inline-block text-purple-300 underline-offset-4 hover:underline">
          View on Solscan ↗
        </a>
      )}
    </div>
  );
}
