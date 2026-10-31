"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { api, API_URL } from "@/lib/api";

// The wallet button reads browser-only wallet state, so render it on the client only.
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false, loading: () => <div className="h-12 w-40 animate-pulse rounded-xl bg-white/10" /> },
);

export function Header() {
  const [backendUp, setBackendUp] = useState<boolean | null>(null);

  useEffect(() => {
    const check = () => api.health().then(() => setBackendUp(true), () => setBackendUp(false));
    void check();
    const t = setInterval(check, 20_000);
    return () => clearInterval(t);
  }, []);

  return (
    <header className="sticky top-0 z-20 w-full border-b border-white/10 bg-[#0b0a12]/80 backdrop-blur">
      <div className="flex w-full items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-10">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-[#9945FF] to-[#14F195]" />
          <div>
            <div className="font-semibold leading-tight">GaslessSwap</div>
            <div className="text-xs text-white/40">Solana mainnet · powered by Jupiter</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span
            title={API_URL}
            className="hidden items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/60 sm:flex"
          >
            <span
              className={`h-2 w-2 rounded-full ${backendUp === null ? "bg-white/40" : backendUp ? "bg-emerald-400" : "bg-red-400"}`}
            />
            {backendUp === null ? "Checking API" : backendUp ? "API online" : "API offline"}
          </span>
          <WalletMultiButton />
        </div>
      </div>
    </header>
  );
}
