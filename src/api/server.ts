import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { Redis } from "ioredis";
import { PublicKey } from "@solana/web3.js";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/pool.js";
import type { Logger } from "../logger.js";
import { registry } from "../metrics.js";
import { accountBalances } from "../ledger/ledgerRepo.js";
import { latestPrices, PRICE_CHANNEL } from "../prices/pricePipeline.js";
import { SponsorLimitError } from "../trade/sponsorGuard.js";
import { TradeError, type TradeService } from "../trade/tradeService.js";
import { JupiterError } from "../solana/jupiter.js";
import { SponsorPolicyError } from "../solana/sponsorPolicy.js";

const pubkey = z.string().refine((s) => {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}, "invalid public key");

const quoteBody = z.object({
  wallet: pubkey,
  inputMint: pubkey,
  outputMint: pubkey,
  amount: z.string().regex(/^\d+$/, "amount must be an integer string in base units").transform(BigInt),
  slippageBps: z.number().int().min(1).max(1_000).default(50),
  creatorId: z.string().max(64).optional(),
});

const previewQuery = z.object({
  inputMint: pubkey,
  outputMint: pubkey,
  amount: z.string().regex(/^\d+$/).transform(BigInt),
  slippageBps: z.coerce.number().int().min(1).max(1_000).default(50),
});

const submitBody = z.object({ signedTransaction: z.string().min(1).max(4_000) });

const creatorBody = z.object({
  id: z.string().regex(/^[a-z0-9_-]{2,64}$/),
  payoutWallet: pubkey,
  commissionBps: z.number().int().min(0).max(10_000),
});

export type ServerDeps = {
  db: Db;
  redis: Redis;
  redisSub: Redis;
  trades: TradeService;
  log: Logger;
  priceMints: string[];
  adminApiKey: string;
  corsOrigins: string[];
};

export async function buildServer(deps: ServerDeps) {
  const app = Fastify({ loggerInstance: deps.log, bodyLimit: 16 * 1024 });
  await app.register(cors, {
    origin: deps.corsOrigins.includes("*") ? true : deps.corsOrigins,
    methods: ["GET", "POST"],
  });
  await app.register(websocket);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "validation", issues: err.issues });
    if (err instanceof TradeError) return reply.status(err.httpStatus).send({ error: err.code, message: err.message });
    if (err instanceof SponsorLimitError) return reply.status(429).send({ error: "sponsor_limit", message: err.message });
    if (err instanceof SponsorPolicyError) return reply.status(422).send({ error: "sponsor_policy", message: err.message });
    if (err instanceof JupiterError) {
      return reply.status(err.retryable ? 503 : 422).send({ error: "routing", message: "no route available, try again" });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: "internal" });
  });

  const requireAdmin = (key: unknown) => {
    const given = Buffer.from(String(key ?? ""));
    const want = Buffer.from(deps.adminApiKey);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new TradeError("unauthorized", 401, "unauthorized");
    }
  };

  // --- health ---
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await Promise.all([deps.db.query("SELECT 1"), deps.redis.ping()]);
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });

  // --- trade path ---
  // Read-only price check for the UI: no transaction is built and no sponsor budget is reserved.
  app.get("/v1/quotes/preview", async (req) => deps.trades.preview(previewQuery.parse(req.query)));

  app.post("/v1/trades/quote", async (req) => deps.trades.quote(quoteBody.parse(req.body)));

  app.get("/v1/trades", async (req) => {
    const { wallet } = z.object({ wallet: pubkey }).parse(req.query);
    return { trades: await deps.trades.listByWallet(wallet) };
  });

  app.post<{ Params: { id: string } }>("/v1/trades/:id/submit", async (req, reply) => {
    const { signedTransaction } = submitBody.parse(req.body);
    const result = await deps.trades.submit(z.string().uuid().parse(req.params.id), signedTransaction);
    return reply.status(202).send(result);
  });

  app.get<{ Params: { id: string } }>("/v1/trades/:id", async (req, reply) => {
    const trade = await deps.trades.get(z.string().uuid().parse(req.params.id));
    return trade ?? reply.status(404).send({ error: "not_found" });
  });

  // --- prices ---
  app.get("/v1/prices", async () => ({ prices: await latestPrices(deps.redis, deps.priceMints) }));

  const sockets = new Set<{ send: (s: string) => void }>();
  await deps.redisSub.subscribe(PRICE_CHANNEL);
  deps.redisSub.on("message", (channel, message) => {
    if (channel !== PRICE_CHANNEL) return;
    for (const s of sockets) s.send(message);
  });

  app.get("/v1/prices/stream", { websocket: true }, async (socket) => {
    sockets.add(socket);
    for (const p of await latestPrices(deps.redis, deps.priceMints)) socket.send(JSON.stringify(p));
    socket.on("close", () => sockets.delete(socket));
  });

  // --- creators / commission ---
  app.post("/v1/admin/creators", async (req, reply) => {
    requireAdmin(req.headers["x-admin-key"]);
    const c = creatorBody.parse(req.body);
    await deps.db.query(
      `INSERT INTO creators (id, payout_wallet, commission_bps) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET payout_wallet = EXCLUDED.payout_wallet, commission_bps = EXCLUDED.commission_bps`,
      [c.id, c.payoutWallet, c.commissionBps],
    );
    return reply.status(201).send(c);
  });

  app.get<{ Params: { id: string } }>("/v1/creators/:id/earnings", async (req) => {
    const id = z.string().regex(/^[a-z0-9_-]{2,64}$/).parse(req.params.id);
    const balances = await accountBalances(deps.db, `creator:${id}:payable`);
    // payable is a credit (negative) balance on our books = positive amount owed to the creator
    return { creatorId: id, owed: balances.map((b) => ({ mint: b.mint, amount: (-BigInt(b.balance)).toString() })) };
  });

  app.get("/v1/admin/ledger", async (req) => {
    requireAdmin(req.headers["x-admin-key"]);
    return { balances: await accountBalances(deps.db, "") };
  });

  return app;
}
