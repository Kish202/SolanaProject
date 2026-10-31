import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createRedisPair, isLocalUrl } from "../src/redis.js";

const base = {
  ADMIN_API_KEY: "x".repeat(24),
  DATABASE_URL: "postgresql://u:p@db.example.com:5432/postgres",
  SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
  SPONSOR_SECRET_KEY: "k",
  PLATFORM_FEE_OWNER: "zPkpoTt4ZExUoEyzKVoDoVJvVvLvZgEgtPoyZMuJY4D",
};

describe("loadConfig", () => {
  it("rejects a localhost DATABASE_URL in production", () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", DATABASE_URL: "postgresql://u:p@localhost:5432/db" }),
    ).toThrow(/DATABASE_URL: points at localhost/);
  });

  it("treats a missing or empty REDIS_URL as not configured", () => {
    expect(loadConfig(base).REDIS_URL).toBeUndefined();
    expect(loadConfig({ ...base, REDIS_URL: "" }).REDIS_URL).toBeUndefined();
  });

  it("accepts hosted URLs in production", () => {
    const cfg = loadConfig({ ...base, NODE_ENV: "production", REDIS_URL: "redis://red-abc:6379" });
    expect(cfg.REDIS_URL).toBe("redis://red-abc:6379");
  });
});

describe("createRedisPair", () => {
  it("falls back to an in-memory Redis that supports pub/sub across connections", async () => {
    const { redis, redisSub, mode } = await createRedisPair(undefined);
    expect(mode).toBe("memory");
    const got = new Promise<string>((resolve) => redisSub.on("message", (_c, m) => resolve(m)));
    await redisSub.subscribe("ch");
    await redis.set("k", "v", "PX", 1_000, "NX");
    await redis.publish("ch", "hello");
    expect(await got).toBe("hello");
    expect(await redis.get("k")).toBe("v");
    await Promise.all([redis.quit(), redisSub.quit()]);
  });

  it("detects localhost URLs", () => {
    expect(isLocalUrl("redis://localhost:6379")).toBe(true);
    expect(isLocalUrl("redis://red-abc:6379")).toBe(false);
  });
});
