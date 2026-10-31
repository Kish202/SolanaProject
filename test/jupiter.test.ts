import { describe, expect, it } from "vitest";
import { JupiterClient, JupiterError } from "../src/solana/jupiter.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const quote = {
  inputMint: SOL,
  outputMint: USDC,
  inAmount: "1000000000",
  outAmount: "150000000",
  otherAmountThreshold: "149250000",
  swapMode: "ExactIn",
  slippageBps: 50,
  priceImpactPct: "0.0001",
  platformFee: { amount: "750000", feeBps: 50 },
  routePlan: [],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("JupiterClient", () => {
  it("sends the platform fee and parses the quote", async () => {
    let url = "";
    const client = new JupiterClient("https://jup.test/swap/v1", async (u) => {
      url = String(u);
      return json(quote);
    });
    const q = await client.quote({ inputMint: SOL, outputMint: USDC, amount: 1_000_000_000n, slippageBps: 50, platformFeeBps: 50 });
    expect(q.outAmount).toBe("150000000");
    expect(q.platformFee?.amount).toBe("750000");
    expect(url).toContain("platformFeeBps=50");
    expect(url).toContain("amount=1000000000");
  });

  it("retries on 429 then succeeds", async () => {
    let calls = 0;
    const client = new JupiterClient("https://jup.test", async () => (++calls < 3 ? json({}, 429) : json(quote)));
    await client.quote({ inputMint: SOL, outputMint: USDC, amount: 1n, slippageBps: 50, platformFeeBps: 0 });
    expect(calls).toBe(3);
  });

  it("does not retry 4xx client errors", async () => {
    let calls = 0;
    const client = new JupiterClient("https://jup.test", async () => {
      calls++;
      return json({ error: "No routes found" }, 400);
    });
    await expect(
      client.quote({ inputMint: SOL, outputMint: USDC, amount: 1n, slippageBps: 50, platformFeeBps: 0 }),
    ).rejects.toBeInstanceOf(JupiterError);
    expect(calls).toBe(1);
  });

  it("decodes swap instructions into web3.js instructions", async () => {
    const ix = { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", accounts: [], data: Buffer.from([9]).toString("base64") };
    const client = new JupiterClient("https://jup.test", async () =>
      json({ computeBudgetInstructions: [], setupInstructions: [], swapInstruction: ix, cleanupInstruction: null, addressLookupTableAddresses: [] }),
    );
    const res = await client.swapInstructions({ quote, userPublicKey: SOL });
    expect(res.swap.data).toEqual(Buffer.from([9]));
    expect(res.cleanup).toEqual([]);
  });
});
