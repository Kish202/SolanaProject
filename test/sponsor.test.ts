import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  assertSponsorable,
  capMicroLamports,
  JUPITER_V6_PROGRAM_ID,
  priorityFeeLamports,
  SponsorPolicyError,
} from "../src/solana/sponsorPolicy.js";
import { extractComputeUnitLimit, hashMessage } from "../src/solana/txBuilder.js";
import { SignedTxError, verifyUserSignedTx } from "../src/solana/verify.js";

const sponsor = Keypair.generate();
const user = Keypair.generate();

const jupiterIx = (keys: PublicKey[] = [user.publicKey]) =>
  new TransactionInstruction({
    programId: JUPITER_V6_PROGRAM_ID,
    keys: keys.map((pubkey) => ({ pubkey, isSigner: pubkey.equals(user.publicKey), isWritable: true })),
    data: Buffer.from([1, 2, 3]),
  });

describe("assertSponsorable", () => {
  it("accepts allow-listed programs that do not touch the sponsor", () => {
    expect(() => assertSponsorable([ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }), jupiterIx()], sponsor.publicKey)).not.toThrow();
  });

  it("rejects instructions that reference the sponsor (e.g. draining it with a transfer)", () => {
    const drain = SystemProgram.transfer({ fromPubkey: sponsor.publicKey, toPubkey: user.publicKey, lamports: 1_000_000_000 });
    expect(() => assertSponsorable([drain], sponsor.publicKey)).toThrow(SponsorPolicyError);
  });

  it("rejects programs that are not allow-listed", () => {
    const unknown = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) });
    expect(() => assertSponsorable([unknown], sponsor.publicKey)).toThrow(/not allow-listed/);
  });
});

describe("priority fee math", () => {
  it("computes lamports from CU limit and micro-lamports per CU", () => {
    expect(priorityFeeLamports(200_000, 50_000n)).toBe(10_000n);
  });

  it("caps the price so total priority fee stays under the max", () => {
    const capped = capMicroLamports(10_000_000n, 200_000, 100_000);
    expect(priorityFeeLamports(200_000, capped)).toBeLessThanOrEqual(100_000n);
    expect(capMicroLamports(10n, 200_000, 100_000)).toBe(10n);
  });

  it("reads the CU limit from Jupiter's compute budget instructions", () => {
    expect(extractComputeUnitLimit([ComputeBudgetProgram.setComputeUnitLimit({ units: 321_000 })])).toBe(321_000);
    expect(extractComputeUnitLimit([])).toBe(400_000);
  });
});

describe("verifyUserSignedTx", () => {
  const build = (ix = jupiterIx()) => {
    const msg = new TransactionMessage({
      payerKey: sponsor.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [ix],
    }).compileToV0Message();
    return new VersionedTransaction(msg);
  };

  it("accepts the exact message the server built, signed by the user", () => {
    const tx = build();
    const hash = hashMessage(tx);
    tx.sign([user]);
    expect(() => verifyUserSignedTx({ tx, expectedMessageHash: hash, sponsor: sponsor.publicKey, user: user.publicKey })).not.toThrow();
  });

  it("rejects a tampered message even if the user signed it", () => {
    const original = build();
    const tampered = build(jupiterIx([user.publicKey, Keypair.generate().publicKey]));
    tampered.sign([user]);
    expect(() =>
      verifyUserSignedTx({ tx: tampered, expectedMessageHash: hashMessage(original), sponsor: sponsor.publicKey, user: user.publicKey }),
    ).toThrow(SignedTxError);
  });

  it("rejects when the user has not signed", () => {
    const tx = build();
    expect(() =>
      verifyUserSignedTx({ tx, expectedMessageHash: hashMessage(tx), sponsor: sponsor.publicKey, user: user.publicKey }),
    ).toThrow(/missing or invalid signature/);
  });

  it("rejects a signature from the wrong key", () => {
    const tx = build();
    const attacker = Keypair.generate();
    tx.signatures[1] = nacl.sign.detached(tx.message.serialize(), attacker.secretKey);
    expect(() =>
      verifyUserSignedTx({ tx, expectedMessageHash: hashMessage(tx), sponsor: sponsor.publicKey, user: user.publicKey }),
    ).toThrow(SignedTxError);
  });
});
