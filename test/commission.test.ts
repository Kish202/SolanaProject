import { describe, expect, it } from "vitest";
import { expectedPlatformFee, splitPlatformFee } from "../src/commission/commission.js";

describe("splitPlatformFee", () => {
  it("splits the fee by commission bps", () => {
    expect(splitPlatformFee(10_000n, 2_000)).toEqual({ platformFee: 10_000n, creatorShare: 2_000n, platformShare: 8_000n });
  });

  it("rounds the creator share down so payouts never exceed what was collected", () => {
    const s = splitPlatformFee(7n, 3_333);
    expect(s.creatorShare).toBe(2n);
    expect(s.creatorShare + s.platformShare).toBe(7n);
  });

  it("handles 0% and 100% commission", () => {
    expect(splitPlatformFee(500n, 0).creatorShare).toBe(0n);
    expect(splitPlatformFee(500n, 10_000).platformShare).toBe(0n);
  });

  it("works with amounts larger than Number.MAX_SAFE_INTEGER", () => {
    const big = 2n ** 80n;
    const s = splitPlatformFee(big, 2_500);
    expect(s.creatorShare).toBe(big / 4n);
  });

  it("rejects invalid input", () => {
    expect(() => splitPlatformFee(-1n, 100)).toThrow(RangeError);
    expect(() => splitPlatformFee(1n, 10_001)).toThrow(RangeError);
    expect(() => splitPlatformFee(1n, 1.5)).toThrow(RangeError);
  });
});

describe("expectedPlatformFee", () => {
  it("computes the bps fee on the output amount", () => {
    expect(expectedPlatformFee(1_000_000n, 50)).toBe(5_000n);
  });
});
