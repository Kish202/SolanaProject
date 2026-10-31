import { splitPlatformFee } from "../commission/commission.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Ledger accounts. Convention: debit = positive, credit = negative, each journal sums to 0 per mint.
 *
 *   platform:treasury:<mint>        asset   — fee tokens sitting in our fee account
 *   platform:fee_revenue            revenue — our share of swap fees
 *   creator:<id>:payable            liability — commission we owe a creator
 *   platform:gas_expense            expense — SOL the sponsor burned on network fees
 *   sponsor:wallet                  asset   — the sponsor's SOL balance
 */
export const Accounts = {
  treasury: (mint: string) => `platform:treasury:${mint}`,
  feeRevenue: "platform:fee_revenue",
  creatorPayable: (creatorId: string) => `creator:${creatorId}:payable`,
  gasExpense: "platform:gas_expense",
  sponsorWallet: "sponsor:wallet",
} as const;

export type Entry = { account: string; mint: string; amount: bigint };
export type Journal = { kind: string; entries: Entry[] };

export class UnbalancedJournalError extends Error {}

export function assertBalanced(journal: Journal): void {
  const sums = new Map<string, bigint>();
  for (const e of journal.entries) sums.set(e.mint, (sums.get(e.mint) ?? 0n) + e.amount);
  for (const [mint, sum] of sums) {
    if (sum !== 0n) throw new UnbalancedJournalError(`journal ${journal.kind} unbalanced for ${mint}: ${sum}`);
  }
}

export type SettledTrade = {
  status: "confirmed" | "failed";
  networkFeeLamports: bigint;
  platformFeeMint: string | null;
  platformFeeAmount: bigint;
  creator: { id: string; commissionBps: number } | null;
};

/**
 * Turns a landed trade into ledger journals.
 * - Gas is always recorded: a failed tx still costs the fee payer its network fee.
 * - Fees and commissions only exist if the swap actually succeeded.
 */
export function journalsForTrade(t: SettledTrade): Journal[] {
  const journals: Journal[] = [];

  if (t.networkFeeLamports > 0n) {
    journals.push({
      kind: "gas",
      entries: [
        { account: Accounts.gasExpense, mint: SOL_MINT, amount: t.networkFeeLamports },
        { account: Accounts.sponsorWallet, mint: SOL_MINT, amount: -t.networkFeeLamports },
      ],
    });
  }

  if (t.status === "confirmed" && t.platformFeeMint && t.platformFeeAmount > 0n) {
    const split = splitPlatformFee(t.platformFeeAmount, t.creator?.commissionBps ?? 0);
    const entries: Entry[] = [
      { account: Accounts.treasury(t.platformFeeMint), mint: t.platformFeeMint, amount: split.platformFee },
      { account: Accounts.feeRevenue, mint: t.platformFeeMint, amount: -split.platformShare },
    ];
    if (t.creator && split.creatorShare > 0n) {
      entries.push({
        account: Accounts.creatorPayable(t.creator.id),
        mint: t.platformFeeMint,
        amount: -split.creatorShare,
      });
    }
    journals.push({ kind: "platform_fee", entries });
  }

  journals.forEach(assertBalanced);
  return journals;
}
