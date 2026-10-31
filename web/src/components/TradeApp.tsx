"use client";

import { useCallback, useState } from "react";
import { usePrices } from "@/hooks/usePrices";
import { HowItWorks } from "./HowItWorks";
import { PriceTicker } from "./PriceTicker";
import { SwapCard } from "./SwapCard";
import { TradeHistory } from "./TradeHistory";

export function TradeApp() {
  const { prices, status } = usePrices();
  const [refreshKey, setRefreshKey] = useState(0);
  const onTradeSettled = useCallback(() => setRefreshKey((k) => k + 1), []);

  return (
    <main className="flex w-full flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
      <section className="w-full">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl lg:text-5xl">
          Swap any Solana token.{" "}
          <span className="bg-gradient-to-r from-[#9945FF] to-[#14F195] bg-clip-text text-transparent">We pay the gas.</span>
        </h1>
        <p className="mt-2 max-w-3xl text-white/50">
          Best-price routing through Jupiter, sponsored network fees, and transactions that land even when the network is busy.
        </p>
      </section>

      <PriceTicker prices={prices} status={status} />

      <div className="grid w-full grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-5 xl:col-span-4">
          <SwapCard prices={prices} onTradeSettled={onTradeSettled} />
        </div>
        <div className="flex flex-col gap-6 lg:col-span-7 xl:col-span-8">
          <TradeHistory refreshKey={refreshKey} />
          <HowItWorks />
        </div>
      </div>
    </main>
  );
}
