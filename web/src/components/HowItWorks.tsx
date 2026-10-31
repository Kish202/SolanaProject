const STEPS = [
  {
    title: "Best route via Jupiter",
    body: "The backend asks Jupiter for the best price across every Solana DEX, then builds the transaction itself.",
  },
  {
    title: "You sign, we pay gas",
    body: "Our sponsor wallet is the fee payer. Your signature only authorises moving your own tokens, so you need no SOL for fees.",
  },
  {
    title: "Verified before co-signing",
    body: "The server checks the message is byte-for-byte what it built, simulates it, and only then adds the sponsor signature.",
  },
  {
    title: "Landed reliably",
    body: "The same signed bytes are rebroadcast until confirmed. If the blockhash expires first, nothing happened and you can retry safely.",
  },
  {
    title: "Booked in the ledger",
    body: "Gas spent, platform fee and creator commission are recorded as a balanced double-entry journal in Postgres.",
  },
];

export function HowItWorks() {
  return (
    <section className="w-full rounded-3xl border border-white/10 bg-white/[0.03] p-5 sm:p-6">
      <h2 className="mb-4 text-lg font-semibold">What happens when you swap</h2>
      <ol className="grid w-full grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-5">
        {STEPS.map((s, i) => (
          <li key={s.title} className="rounded-2xl bg-black/20 p-4">
            <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-[#9945FF] to-[#14F195] text-xs font-bold text-black">
              {i + 1}
            </div>
            <h3 className="mb-1 font-medium">{s.title}</h3>
            <p className="text-sm leading-relaxed text-white/50">{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
