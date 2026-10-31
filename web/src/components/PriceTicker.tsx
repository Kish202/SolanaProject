"use client";

import type { FeedStatus, LivePrice } from "@/hooks/usePrices";
import { TOKENS } from "@/lib/tokens";
import { TokenBadge } from "./TokenBadge";

const STATUS_STYLE: Record<FeedStatus, { dot: string; label: string }> = {
  connecting: { dot: "bg-white/40", label: "Connecting" },
  live: { dot: "bg-emerald-400", label: "Live · WebSocket" },
  polling: { dot: "bg-amber-400", label: "Polling" },
  offline: { dot: "bg-red-400", label: "Backend offline" },
};

export function PriceTicker({ prices, status }: { prices: Record<string, LivePrice>; status: FeedStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <section className="w-full">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wider text-white/50">Live prices</h2>
        <span className="flex items-center gap-2 text-xs text-white/50">
          <span className={`h-2 w-2 rounded-full ${s.dot} ${status === "live" ? "animate-pulse" : ""}`} />
          {s.label}
        </span>
      </div>
      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
        {TOKENS.map((t) => {
          const p = prices[t.mint];
          const change = p?.change24h ?? null;
          return (
            <div key={t.mint} className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <TokenBadge token={t} size={40} />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white/50">{t.name}</div>
                <div
                  key={p?.ts}
                  className={`text-2xl font-semibold tabular-nums ${p?.direction === "up" ? "flash-up" : p?.direction === "down" ? "flash-down" : ""}`}
                >
                  {p ? `$${p.usd.toLocaleString("en-US", { maximumFractionDigits: p.usd < 1 ? 4 : 2, minimumFractionDigits: 2 })}` : "—"}
                </div>
              </div>
              {change !== null && (
                <span
                  className={`rounded-full px-2 py-1 text-xs font-medium ${change >= 0 ? "bg-emerald-400/10 text-emerald-300" : "bg-red-400/10 text-red-300"}`}
                >
                  {change >= 0 ? "+" : ""}
                  {change.toFixed(2)}%
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
