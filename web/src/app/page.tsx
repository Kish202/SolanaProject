import { Header } from "@/components/Header";
import { TradeApp } from "@/components/TradeApp";

export default function Home() {
  return (
    <>
      <Header />
      <TradeApp />
      <footer className="w-full border-t border-white/10 px-4 py-6 text-xs text-white/30 sm:px-6 lg:px-10">
        Trades execute on Solana mainnet with real funds. Network fees are paid by the platform; a small platform fee may apply.
      </footer>
    </>
  );
}
