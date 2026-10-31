/**
 * Creator commission: a creator (e.g. an influencer whose referral link the trader used)
 * earns `commissionBps` of the platform fee collected on that trade.
 *
 * All math is integer (bigint) in the token's smallest unit. Rounding always favours the
 * platform (floor on the creator share) so the sum of payouts can never exceed what was
 * actually collected on-chain.
 */

export const BPS_DENOMINATOR = 10_000n;

export type CommissionSplit = {
  platformFee: bigint;
  creatorShare: bigint;
  platformShare: bigint;
};

export function splitPlatformFee(platformFee: bigint, commissionBps: number): CommissionSplit {
  if (platformFee < 0n) throw new RangeError("platformFee must be >= 0");
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10_000) {
    throw new RangeError("commissionBps must be an integer in [0, 10000]");
  }
  const creatorShare = (platformFee * BigInt(commissionBps)) / BPS_DENOMINATOR;
  return { platformFee, creatorShare, platformShare: platformFee - creatorShare };
}

/** Platform fee Jupiter takes from the output amount, used to sanity-check the quote. */
export function expectedPlatformFee(outAmountBeforeFee: bigint, feeBps: number): bigint {
  return (outAmountBeforeFee * BigInt(feeBps)) / BPS_DENOMINATOR;
}
