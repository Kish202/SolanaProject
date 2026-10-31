import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "../src/solana/tokenPrograms.js";

const owner = new PublicKey("zPkpoTt4ZExUoEyzKVoDoVJvVvLvZgEgtPoyZMuJY4D");
const usdc = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

describe("getAssociatedTokenAddressSync", () => {
  it("matches the addresses derived by @solana/spl-token", () => {
    expect(getAssociatedTokenAddressSync(usdc, owner).toBase58()).toBe("HcnagdTzhxYUjU9YPsFzAn4J6R6jLF5zjQLHUoBdJxuq");
    expect(getAssociatedTokenAddressSync(usdc, owner, false, TOKEN_2022_PROGRAM_ID).toBase58()).toBe(
      "ANgCgTeKsiewBsGRC4Z2VAV4Xek5HBUSUtR98rTzANSX",
    );
  });

  it("rejects off-curve owners unless allowed", () => {
    const pda = getAssociatedTokenAddressSync(usdc, owner);
    expect(() => getAssociatedTokenAddressSync(usdc, pda)).toThrow(/off curve/);
    expect(getAssociatedTokenAddressSync(usdc, pda, true)).toBeInstanceOf(PublicKey);
  });
});
