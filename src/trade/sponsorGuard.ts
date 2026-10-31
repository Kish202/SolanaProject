import type { Redis } from "ioredis";

export class SponsorLimitError extends Error {}

/**
 * Abuse limits for gas sponsorship, backed by Redis so they hold across all API instances.
 *   - per-wallet hourly transaction cap (stops one wallet draining the sponsor)
 *   - global daily lamport budget (bounds worst-case loss if something goes wrong)
 */
export class SponsorGuard {
  constructor(
    private readonly redis: Redis,
    private readonly maxTxPerWalletPerHour: number,
    private readonly dailyBudgetLamports: bigint,
  ) {}

  async reserve(wallet: string, maxLamports: bigint): Promise<void> {
    const hour = Math.floor(Date.now() / 3_600_000);
    const walletKey = `sponsor:wallet:${wallet}:${hour}`;
    const count = await this.redis.multi().incr(walletKey).expire(walletKey, 3_600).exec();
    const used = Number(count?.[0]?.[1] ?? 0);
    if (used > this.maxTxPerWalletPerHour) {
      throw new SponsorLimitError("hourly sponsored transaction limit reached for this wallet");
    }

    const budgetKey = this.budgetKey();
    const spent = BigInt((await this.redis.get(budgetKey)) ?? "0");
    if (spent + maxLamports > this.dailyBudgetLamports) {
      throw new SponsorLimitError("sponsor daily budget exhausted");
    }
  }

  /** Record what the sponsor actually paid once the tx lands (fee is charged even on failure). */
  async recordSpend(lamports: bigint): Promise<void> {
    const key = this.budgetKey();
    await this.redis.multi().incrby(key, Number(lamports)).expire(key, 2 * 86_400).exec();
  }

  async spentToday(): Promise<bigint> {
    return BigInt((await this.redis.get(this.budgetKey())) ?? "0");
  }

  private budgetKey() {
    return `sponsor:budget:${new Date().toISOString().slice(0, 10)}`;
  }
}
