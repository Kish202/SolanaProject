import { describe, expect, it } from "vitest";
import { hasMoved, nextPollDelay, parsePrices } from "../src/prices/pricePipeline.js";

describe("nextPollDelay", () => {
  it("backs off exponentially on failures and caps at 60s", () => {
    expect(nextPollDelay(2_000, 0)).toBe(2_000);
    expect(nextPollDelay(2_000, 2)).toBe(8_000);
    expect(nextPollDelay(2_000, 50)).toBe(60_000);
  });
});

describe("parsePrices", () => {
  it("normalises the Jupiter price response", () => {
    const ticks = parsePrices({ So111: { usdPrice: 150.25, blockId: 1, priceChange24h: -1.2 } }, 42);
    expect(ticks).toEqual([{ mint: "So111", usd: 150.25, ts: 42, change24h: -1.2 }]);
  });

  it("drops zero or invalid prices instead of publishing them", () => {
    expect(parsePrices({ a: { usdPrice: 0 } }, 1)).toEqual([]);
    expect(parsePrices({ a: { usdPrice: "nope" } }, 1)).toEqual([]);
  });
});

describe("hasMoved", () => {
  it("publishes the first tick and meaningful moves only", () => {
    expect(hasMoved(undefined, 100)).toBe(true);
    expect(hasMoved(100, 100)).toBe(false);
    expect(hasMoved(100, 100.02)).toBe(true);
    expect(hasMoved(100, 100.001, 1)).toBe(false);
  });
});
