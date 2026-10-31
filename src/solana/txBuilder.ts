import { createHash } from "node:crypto";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { JupiterSwapInstructions } from "./jupiter.js";
import { assertSponsorable, capMicroLamports } from "./sponsorPolicy.js";

const SET_COMPUTE_UNIT_LIMIT = 2;
const DEFAULT_CU_LIMIT = 400_000;

export type BuiltTx = {
  tx: VersionedTransaction;
  messageHash: string;
  blockhash: string;
  lastValidBlockHeight: number;
  computeUnitLimit: number;
  microLamportsPerCu: bigint;
};

export function hashMessage(tx: VersionedTransaction): string {
  return createHash("sha256").update(tx.message.serialize()).digest("hex");
}

/** Jupiter returns a SetComputeUnitLimit sized by simulation; we keep that and add our own price. */
export function extractComputeUnitLimit(ixs: TransactionInstruction[]): number {
  for (const ix of ixs) {
    if (ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === SET_COMPUTE_UNIT_LIMIT) {
      return ix.data.readUInt32LE(1);
    }
  }
  return DEFAULT_CU_LIMIT;
}

export function composeInstructions(
  swap: JupiterSwapInstructions,
  computeUnitLimit: number,
  microLamportsPerCu: bigint,
): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microLamportsPerCu }),
    ...swap.setup,
    swap.swap,
    ...swap.cleanup,
    ...swap.other,
  ];
}

/**
 * Median recent priority fee for the accounts this tx writes to. Using the writable accounts
 * (not a global number) matters: fees are local to hot accounts like busy AMM pools.
 */
export async function estimatePriorityFee(connection: Connection, ixs: TransactionInstruction[]): Promise<bigint> {
  const writable = new Map<string, PublicKey>();
  for (const ix of ixs) for (const k of ix.keys) if (k.isWritable) writable.set(k.pubkey.toBase58(), k.pubkey);
  const lockedWritableAccounts = [...writable.values()].slice(0, 128);
  try {
    const fees = await connection.getRecentPrioritizationFees({ lockedWritableAccounts });
    const values = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
    if (values.length === 0) return 10_000n;
    return BigInt(values[Math.floor(values.length * 0.75)] ?? values[values.length - 1] ?? 10_000);
  } catch {
    return 10_000n;
  }
}

export async function loadLookupTables(connection: Connection, keys: PublicKey[]): Promise<AddressLookupTableAccount[]> {
  if (keys.length === 0) return [];
  const infos = await connection.getMultipleAccountsInfo(keys);
  return infos.flatMap((info, i) => {
    const key = keys[i];
    if (!info || !key) return [];
    return [new AddressLookupTableAccount({ key, state: AddressLookupTableAccount.deserialize(info.data) })];
  });
}

export async function buildSponsoredSwapTx(args: {
  connection: Connection;
  swap: JupiterSwapInstructions;
  sponsor: PublicKey;
  maxPriorityFeeLamports: number;
}): Promise<BuiltTx> {
  const { connection, swap, sponsor } = args;
  const computeUnitLimit = extractComputeUnitLimit(swap.computeBudget);

  const draft = composeInstructions(swap, computeUnitLimit, 0n);
  assertSponsorable(draft, sponsor);

  const desired = await estimatePriorityFee(connection, draft);
  const microLamportsPerCu = capMicroLamports(desired, computeUnitLimit, args.maxPriorityFeeLamports);
  const instructions = composeInstructions(swap, computeUnitLimit, microLamportsPerCu);

  const [lookupTables, { blockhash, lastValidBlockHeight }] = await Promise.all([
    loadLookupTables(connection, swap.lookupTables),
    connection.getLatestBlockhash("confirmed"),
  ]);

  const message = new TransactionMessage({
    payerKey: sponsor,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(message);
  return { tx, messageHash: hashMessage(tx), blockhash, lastValidBlockHeight, computeUnitLimit, microLamportsPerCu };
}
