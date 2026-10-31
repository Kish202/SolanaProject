import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { logger } from "./logger.js";
import { createRedis } from "./redis.js";
import { JupiterClient } from "./solana/jupiter.js";
import { PricePipeline } from "./prices/pricePipeline.js";
import { SponsorGuard } from "./trade/sponsorGuard.js";
import { TradeService } from "./trade/tradeService.js";
import { buildServer } from "./api/server.js";
import { sponsorBalanceLamports } from "./metrics.js";
import { loadSecretsIntoEnv } from "./secrets.js";

async function main() {
  await loadSecretsIntoEnv();
  const cfg = loadConfig();
  const db = createPool(cfg.DATABASE_URL, { sslMode: cfg.DATABASE_SSL, sslCa: cfg.DATABASE_SSL_CA });
  const redis = createRedis(cfg.REDIS_URL);
  const redisSub = createRedis(cfg.REDIS_URL);

  const connection = new Connection(cfg.SOLANA_RPC_URL, { commitment: cfg.SOLANA_COMMITMENT });
  const broadcastRpcs = cfg.SOLANA_SEND_RPC_URLS.map((url) => new Connection(url, { commitment: cfg.SOLANA_COMMITMENT }));
  const sponsor = Keypair.fromSecretKey(bs58.decode(cfg.SPONSOR_SECRET_KEY));
  logger.info({ sponsor: sponsor.publicKey.toBase58() }, "gas sponsor loaded");

  const trades = new TradeService({
    db,
    connection,
    broadcastRpcs,
    jupiter: new JupiterClient(cfg.JUPITER_API_URL),
    sponsor,
    guard: new SponsorGuard(redis, cfg.SPONSOR_MAX_TX_PER_WALLET_PER_HOUR, cfg.SPONSOR_DAILY_BUDGET_LAMPORTS),
    log: logger,
    platformFeeBps: cfg.PLATFORM_FEE_BPS,
    platformFeeOwner: new PublicKey(cfg.PLATFORM_FEE_OWNER),
    maxPriorityFeeLamports: cfg.PRIORITY_FEE_MAX_LAMPORTS,
  });

  const prices = new PricePipeline(redis, logger, {
    priceUrl: cfg.JUPITER_PRICE_URL,
    mints: cfg.PRICE_MINTS,
    pollMs: cfg.PRICE_POLL_MS,
  });

  const app = await buildServer({
    db,
    redis,
    redisSub,
    trades,
    log: logger,
    priceMints: cfg.PRICE_MINTS,
    adminApiKey: cfg.ADMIN_API_KEY,
    corsOrigins: cfg.CORS_ORIGINS,
  });

  const recovered = await trades.recoverInFlight();
  if (recovered) logger.warn({ recovered }, "resumed in-flight trades after restart");

  prices.start();
  await app.listen({ port: cfg.PORT, host: "0.0.0.0" });

  // The CloudWatch alarm on low sponsor balance reads this structured log line.
  const checkSponsorBalance = async () => {
    try {
      const lamports = await connection.getBalance(sponsor.publicKey, "confirmed");
      sponsorBalanceLamports.set(lamports);
      logger.info({ event: "sponsor_balance", lamports }, "sponsor balance");
    } catch (err) {
      logger.warn({ err }, "sponsor balance check failed");
    }
  };
  void checkSponsorBalance();
  const balanceTimer = setInterval(checkSponsorBalance, 60_000);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    clearInterval(balanceTimer);
    prices.stop();
    await app.close();
    await Promise.allSettled([db.end(), redis.quit(), redisSub.quit()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "failed to start");
  process.exit(1);
});
