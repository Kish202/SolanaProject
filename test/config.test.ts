import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  ADMIN_API_KEY: "x".repeat(24),
  DATABASE_URL: "postgresql://u:p@db.example.com:5432/postgres",
  REDIS_URL: "redis://red-abc:6379",
  SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
  SPONSOR_SECRET_KEY: "k",
  PLATFORM_FEE_OWNER: "zPkpoTt4ZExUoEyzKVoDoVJvVvLvZgEgtPoyZMuJY4D",
};

describe("loadConfig", () => {
  it("rejects a localhost REDIS_URL in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", REDIS_URL: "redis://localhost:6379" })).toThrow(
      /REDIS_URL: points at localhost/,
    );
  });

  it("allows localhost outside production", () => {
    expect(loadConfig({ ...base, REDIS_URL: "redis://localhost:6379" }).REDIS_URL).toBe("redis://localhost:6379");
  });

  it("accepts hosted URLs in production", () => {
    expect(loadConfig({ ...base, NODE_ENV: "production" }).NODE_ENV).toBe("production");
  });
});
