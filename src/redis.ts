import { Redis } from "ioredis";

export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: 3, enableReadyCheck: true });
}

export type { Redis };
