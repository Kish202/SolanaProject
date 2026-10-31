import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const txOutcomes = new client.Counter({
  name: "trade_tx_outcomes_total",
  help: "Final outcome of submitted trade transactions",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const txLandingSeconds = new client.Histogram({
  name: "trade_tx_landing_seconds",
  help: "Time from first send to confirmation",
  buckets: [0.5, 1, 2, 4, 8, 15, 30, 60, 90],
  registers: [registry],
});

export const txRebroadcasts = new client.Counter({
  name: "trade_tx_rebroadcasts_total",
  help: "Number of rebroadcast attempts",
  registers: [registry],
});

export const sponsorSpendLamports = new client.Counter({
  name: "sponsor_spend_lamports_total",
  help: "Lamports spent by the gas sponsor on network fees",
  registers: [registry],
});

export const sponsorBalanceLamports = new client.Gauge({
  name: "sponsor_balance_lamports",
  help: "Current SOL balance of the gas sponsor wallet",
  registers: [registry],
});

export const priceUpdates = new client.Counter({
  name: "price_updates_total",
  help: "Price updates published",
  labelNames: ["result"] as const,
  registers: [registry],
});

export const rpcErrors = new client.Counter({
  name: "rpc_errors_total",
  help: "RPC errors by method",
  labelNames: ["method"] as const,
  registers: [registry],
});
