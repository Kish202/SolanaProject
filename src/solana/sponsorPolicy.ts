import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./tokenPrograms.js";

/**
 * Rules the gas sponsor enforces before it will pay for (and sign) a transaction.
 *
 * The sponsor is the fee payer, so its signature authorises the network to debit it.
 * If the sponsor key also appeared inside any instruction, a malicious message could
 * make the sponsor transfer SOL, pay account rent, or act as an authority. So:
 *   1. The sponsor may only be the fee payer — never referenced by any instruction.
 *   2. Only allow-listed programs may be invoked.
 *   3. Priority fee spend is capped.
 */

export const JUPITER_V6_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export const DEFAULT_ALLOWED_PROGRAMS: readonly PublicKey[] = [
  ComputeBudgetProgram.programId,
  SystemProgram.programId,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  JUPITER_V6_PROGRAM_ID,
  MEMO_PROGRAM_ID,
];

export class SponsorPolicyError extends Error {}

export function assertSponsorable(
  instructions: TransactionInstruction[],
  sponsor: PublicKey,
  allowedPrograms: readonly PublicKey[] = DEFAULT_ALLOWED_PROGRAMS,
): void {
  const allowed = new Set(allowedPrograms.map((p) => p.toBase58()));
  for (const [i, ix] of instructions.entries()) {
    if (!allowed.has(ix.programId.toBase58())) {
      throw new SponsorPolicyError(`instruction ${i}: program ${ix.programId.toBase58()} is not allow-listed`);
    }
    if (ix.keys.some((k) => k.pubkey.equals(sponsor))) {
      throw new SponsorPolicyError(`instruction ${i}: sponsor account may only be used as fee payer`);
    }
  }
}

/** Total priority fee in lamports = CU limit * micro-lamports per CU / 1e6 (rounded up). */
export function priorityFeeLamports(computeUnitLimit: number, microLamportsPerCu: bigint): bigint {
  return (BigInt(computeUnitLimit) * microLamportsPerCu + 999_999n) / 1_000_000n;
}

/** Largest micro-lamport price that keeps the total priority fee under the cap. */
export function capMicroLamports(desired: bigint, computeUnitLimit: number, maxLamports: number): bigint {
  if (computeUnitLimit <= 0) return 0n;
  const ceiling = (BigInt(maxLamports) * 1_000_000n) / BigInt(computeUnitLimit);
  return desired < ceiling ? desired : ceiling;
}
