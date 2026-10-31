import "dotenv/config";
import { z } from "zod";

const csv = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const schema = z.object({
  PORT: z.coerce.number().default(8080),
  LOG_LEVEL: z.string().default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ADMIN_API_KEY: z.string().min(24, "ADMIN_API_KEY must be at least 24 characters"),
  CORS_ORIGINS: z.string().default("http://localhost:3000").transform(csv),

  DATABASE_URL: z.string().url(),
  DATABASE_SSL: z.enum(["disable", "require", "verify"]).optional(),
  DATABASE_SSL_CA: z.string().optional(),
  REDIS_URL: z.string().url(),

  SOLANA_RPC_URL: z.string().url(),
  SOLANA_SEND_RPC_URLS: z.string().default("").transform(csv),
  SOLANA_COMMITMENT: z.enum(["processed", "confirmed", "finalized"]).default("confirmed"),
  SPONSOR_SECRET_KEY: z.string().min(1, "SPONSOR_SECRET_KEY is required"),

  JUPITER_API_URL: z.string().url().default("https://lite-api.jup.ag/swap/v1"),
  JUPITER_PRICE_URL: z.string().url().default("https://lite-api.jup.ag/price/v3"),

  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(50),
  PLATFORM_FEE_OWNER: z.string().min(32),

  SPONSOR_MAX_TX_PER_WALLET_PER_HOUR: z.coerce.number().int().positive().default(30),
  SPONSOR_DAILY_BUDGET_LAMPORTS: z.coerce.bigint().default(2_000_000_000n),
  PRIORITY_FEE_MAX_LAMPORTS: z.coerce.number().int().positive().default(200_000),

  PRICE_MINTS: z.string().default("So11111111111111111111111111111111111111112").transform(csv),
  PRICE_POLL_MS: z.coerce.number().int().min(250).default(2000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
