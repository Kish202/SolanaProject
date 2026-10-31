import type { Redis } from "ioredis";
import { z } from "zod";
import type { Logger } from "../logger.js";
import { priceUpdates } from "../metrics.js";

/**
 * Live price pipeline:
 *   Jupiter Price API --poll--> normalise --> Redis (latest snapshot) --pub/sub--> every API pod --> WebSocket clients
 *
 * Only one poller needs to run (it takes a Redis lock), but every API instance can serve
 * WebSocket clients because they all subscribe to the same Redis channel.
 */

export const PRICE_CHANNEL = "prices";
export const priceKey = (mint: string) => `price:${mint}`;
const LOCK_KEY = "lock:price-poller";

const priceResponse = z.record(
  z.object({ usdPrice: z.number(), blockId: z.number().nullable().optional(), priceChange24h: z.number().nullable().optional() }),
);

export type PriceTick = { mint: string; usd: number; ts: number; change24h: number | null };

export function parsePrices(json: unknown, ts: number): PriceTick[] {
  const parsed = priceResponse.safeParse(json);
  if (!parsed.success) return [];
  return Object.entries(parsed.data)
    .filter(([, v]) => Number.isFinite(v.usdPrice) && v.usdPrice > 0)
    .map(([mint, v]) => ({ mint, usd: v.usdPrice, ts, change24h: v.priceChange24h ?? null }));
}

/** Skip publishing if the price moved less than `minMoveBps` — avoids flooding clients with noise. */
export function hasMoved(prev: number | undefined, next: number, minMoveBps = 1): boolean {
  if (prev === undefined) return true;
  return (Math.abs(next - prev) / prev) * 10_000 >= minMoveBps;
}

/** Exponential backoff on consecutive failures (e.g. 429s), capped at 60s. */
export function nextPollDelay(pollMs: number, consecutiveFailures: number): number {
  return Math.min(pollMs * 2 ** Math.min(consecutiveFailures, 10), 60_000);
}

export class PricePipeline {
  private timer: NodeJS.Timeout | undefined;
  private readonly last = new Map<string, number>();
  private readonly instanceId = `${process.pid}-${Math.random().toString(36).slice(2)}`;

  constructor(
    private readonly redis: Redis,
    private readonly log: Logger,
    private readonly opts: { priceUrl: string; mints: string[]; pollMs: number; apiKey?: string; fetchImpl?: typeof fetch },
  ) {}

  start(): void {
    let failures = 0;
    const tick = async () => {
      try {
        if (await this.holdLock()) await this.pollOnce();
        failures = 0;
      } catch (err) {
        failures++;
        priceUpdates.inc({ result: "error" });
        this.log.warn({ err, failures }, "price poll failed");
      } finally {
        this.timer = setTimeout(tick, nextPollDelay(this.opts.pollMs, failures));
      }
    };
    void tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  async pollOnce(): Promise<PriceTick[]> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const url = `${this.opts.priceUrl}?ids=${this.opts.mints.join(",")}`;
    const headers: Record<string, string> = this.opts.apiKey ? { "x-api-key": this.opts.apiKey } : {};
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(3_000) });
    if (!res.ok) throw new Error(`price api ${res.status}`);
    const ticks = parsePrices(await res.json(), Date.now());

    const moved = ticks.filter((t) => hasMoved(this.last.get(t.mint), t.usd));
    if (moved.length === 0) return [];

    const pipe = this.redis.pipeline();
    for (const t of moved) {
      this.last.set(t.mint, t.usd);
      pipe.set(priceKey(t.mint), JSON.stringify(t), "EX", 60);
      pipe.publish(PRICE_CHANNEL, JSON.stringify(t));
    }
    await pipe.exec();
    priceUpdates.inc({ result: "published" }, moved.length);
    return moved;
  }

  private async holdLock(): Promise<boolean> {
    const ttl = Math.max(this.opts.pollMs * 3, 5_000);
    const acquired = await this.redis.set(LOCK_KEY, this.instanceId, "PX", ttl, "NX");
    if (acquired) return true;
    if ((await this.redis.get(LOCK_KEY)) === this.instanceId) {
      await this.redis.pexpire(LOCK_KEY, ttl);
      return true;
    }
    return false;
  }
}

export async function latestPrices(redis: Redis, mints: string[]): Promise<PriceTick[]> {
  if (mints.length === 0) return [];
  const raw = await redis.mget(mints.map(priceKey));
  return raw.flatMap((r) => (r ? [JSON.parse(r) as PriceTick] : []));
}
