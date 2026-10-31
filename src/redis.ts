import { Redis } from "ioredis";

export type RedisMode = "redis" | "memory";

/**
 * With no REDIS_URL the app uses an in-process Redis (ioredis-mock). Rate limits, the sponsor
 * budget and the price lock then live in this one process, so it is only safe with a single
 * instance; run real Redis before scaling out.
 */
export async function createRedisPair(url: string | undefined): Promise<{ redis: Redis; redisSub: Redis; mode: RedisMode }> {
  if (!url) {
    const { default: RedisMock } = await import("ioredis-mock");
    return { redis: new RedisMock() as unknown as Redis, redisSub: new RedisMock() as unknown as Redis, mode: "memory" };
  }
  return { redis: createRedis(url), redisSub: createRedis(url), mode: "redis" };
}

export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: 3, enableReadyCheck: true });
}

export function isLocalUrl(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export type { Redis };
