import { describe, expect, it } from "vitest";
import { Accounts, assertBalanced, journalsForTrade, SOL_MINT, UnbalancedJournalError } from "../src/ledger/journal.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("journalsForTrade", () => {
  it("records gas, fee revenue and creator payable for a confirmed trade", () => {
    const journals = journalsForTrade({
      status: "confirmed",
      networkFeeLamports: 15_000n,
      platformFeeMint: USDC,
      platformFeeAmount: 1_000n,
      creator: { id: "alice", commissionBps: 2_000 },
    });

    expect(journals.map((j) => j.kind)).toEqual(["gas", "platform_fee"]);
    const fee = journals[1]!.entries;
    expect(fee).toContainEqual({ account: Accounts.treasury(USDC), mint: USDC, amount: 1_000n });
    expect(fee).toContainEqual({ account: Accounts.feeRevenue, mint: USDC, amount: -800n });
    expect(fee).toContainEqual({ account: Accounts.creatorPayable("alice"), mint: USDC, amount: -200n });
  });

  it("records only gas when the swap failed on-chain (fee paid, no revenue)", () => {
    const journals = journalsForTrade({
      status: "failed",
      networkFeeLamports: 10_000n,
      platformFeeMint: USDC,
      platformFeeAmount: 1_000n,
      creator: { id: "alice", commissionBps: 2_000 },
    });
    expect(journals).toHaveLength(1);
    expect(journals[0]!.entries).toEqual([
      { account: Accounts.gasExpense, mint: SOL_MINT, amount: 10_000n },
      { account: Accounts.sponsorWallet, mint: SOL_MINT, amount: -10_000n },
    ]);
  });

  it("books the full fee to the platform when there is no creator", () => {
    const [, fee] = journalsForTrade({
      status: "confirmed",
      networkFeeLamports: 5_000n,
      platformFeeMint: USDC,
      platformFeeAmount: 999n,
      creator: null,
    });
    expect(fee!.entries).toHaveLength(2);
    expect(fee!.entries[1]).toEqual({ account: Accounts.feeRevenue, mint: USDC, amount: -999n });
  });
});

describe("assertBalanced", () => {
  it("throws on an unbalanced journal", () => {
    expect(() =>
      assertBalanced({ kind: "bad", entries: [{ account: "a", mint: USDC, amount: 5n }, { account: "b", mint: USDC, amount: -4n }] }),
    ).toThrow(UnbalancedJournalError);
  });

  it("balances per mint, not across mints", () => {
    expect(() =>
      assertBalanced({ kind: "bad", entries: [{ account: "a", mint: USDC, amount: 5n }, { account: "b", mint: SOL_MINT, amount: -5n }] }),
    ).toThrow(UnbalancedJournalError);
  });
});
