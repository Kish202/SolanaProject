"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { api, solscanTx, type Trade, type TradeStatus } from "@/lib/api";
import { fromBaseUnits, tokenByMint, shortAddress } from "@/lib/tokens";

const STATUS: Record<TradeStatus, string> = {
  built: "bg-white/10 text-white/60",
  submitted: "bg-purple-400/10 text-purple-300",
  confirmed: "bg-emerald-400/10 text-emerald-300",
  failed: "bg-red-400/10 text-red-300",
  expired: "bg-amber-400/10 text-amber-300",
};

export function TradeHistory({ refreshKey }: { refreshKey: number }) {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [result, setResult] = useState<{ wallet: string; trades: Trade[] | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    api
      .trades(wallet)
      .then((r) => !cancelled && setResult({ wallet, trades: r.trades, error: null }))
      .catch((e) => !cancelled && setResult({ wallet, trades: null, error: e.message }));
    return () => {
      cancelled = true;
    };
  }, [wallet, refreshKey]);

  const current = result && result.wallet === wallet ? result : null;
  const trades = current?.trades ?? null;
  const error = current?.error ?? null;

  return (
    <section className="w-full rounded-3xl border border-white/10 bg-white/[0.03] p-5 sm:p-6">
      <h2 className="mb-4 text-lg font-semibold">Your trades</h2>
      {!publicKey && <p className="text-sm text-white/40">Connect a wallet to see your trade history.</p>}
      {error && <p className="text-sm text-red-300">{error}</p>}
      {publicKey && trades?.length === 0 && <p className="text-sm text-white/40">No trades yet. Make your first gas-free swap.</p>}
      {trades && trades.length > 0 && (
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-white/40">
              <tr>
                <th className="pb-3 font-medium">Swap</th>
                <th className="pb-3 font-medium">Status</th>
                <th className="pb-3 font-medium">Gas paid by us</th>
                <th className="pb-3 font-medium">Time</th>
                <th className="pb-3 text-right font-medium">Tx</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {trades.map((t) => {
                const a = tokenByMint(t.input_mint);
                const b = tokenByMint(t.output_mint);
                return (
                  <tr key={t.id}>
                    <td className="py-3">
                      {a ? fromBaseUnits(t.in_amount, a.decimals) : t.in_amount} {a?.symbol ?? "?"} →{" "}
                      {b ? fromBaseUnits(t.quoted_out_amount, b.decimals) : t.quoted_out_amount} {b?.symbol ?? "?"}
                    </td>
                    <td className="py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[t.status]}`} title={t.error ?? undefined}>
                        {t.status}
                      </span>
                    </td>
                    <td className="py-3 tabular-nums text-white/70">
                      {t.network_fee_lamports ? `${fromBaseUnits(t.network_fee_lamports, 9, 9)} SOL` : "—"}
                    </td>
                    <td className="py-3 text-white/50">{new Date(t.created_at).toLocaleTimeString()}</td>
                    <td className="py-3 text-right">
                      {t.signature ? (
                        <a href={solscanTx(t.signature)} target="_blank" rel="noreferrer" className="text-purple-300 hover:underline">
                          {shortAddress(t.signature)} ↗
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
