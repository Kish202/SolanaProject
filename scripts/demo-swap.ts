/**
 * End-to-end demo of the client side of the trade path:
 *   quote -> sign locally (user wallet) -> submit -> poll status
 *
 * Usage:
 *   USER_SECRET_KEY=<base58> API_URL=http://localhost:8080 npx tsx scripts/demo-swap.ts 10000000
 * (amount is in lamports: 10000000 = 0.01 SOL, swapped to USDC)
 *
 * This moves real funds on mainnet. Use a throwaway wallet with a tiny balance.
 */
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

const API = process.env.API_URL ?? "http://localhost:8080";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function main() {
  const secret = process.env.USER_SECRET_KEY;
  if (!secret) throw new Error("USER_SECRET_KEY is required");
  const user = Keypair.fromSecretKey(bs58.decode(secret));
  const amount = process.argv[2] ?? "10000000";

  const quoteRes = await fetch(`${API}/v1/trades/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: user.publicKey.toBase58(), inputMint: SOL, outputMint: USDC, amount, slippageBps: 50 }),
  });
  const quote = await quoteRes.json();
  if (!quoteRes.ok) throw new Error(JSON.stringify(quote));
  console.log("quote", quote.quote, "gas", quote.gas);

  // This is what a wallet (Phantom, Backpack...) does when the user clicks "Approve".
  const tx = VersionedTransaction.deserialize(Buffer.from(quote.transaction, "base64"));
  tx.sign([user]);

  const submitRes = await fetch(`${API}/v1/trades/${quote.tradeId}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedTransaction: Buffer.from(tx.serialize()).toString("base64") }),
  });
  const submitted = await submitRes.json();
  if (!submitRes.ok) throw new Error(JSON.stringify(submitted));
  console.log("submitted", submitted.signature);

  for (let i = 0; i < 120; i++) {
    const t = await (await fetch(`${API}/v1/trades/${quote.tradeId}`)).json();
    if (t.status !== "submitted") {
      console.log("final", t.status, t.error ?? "", `https://solscan.io/tx/${t.signature}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
