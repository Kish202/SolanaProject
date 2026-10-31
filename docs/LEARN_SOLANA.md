# Solana in plain English: a study guide for this project

Read this top to bottom, then open each file it points to. By the end you should be able to explain every part of the codebase in your own words.

---

## 1. The basics

**Solana** is a blockchain: a shared database that thousands of computers (validators) agree on. It's fast, producing a new "slot" about every 400 ms, and cheap, with a basic transaction costing 0.000005 SOL.

**SOL** is the native coin. Its smallest unit is the **lamport**: 1 SOL = 1,000,000,000 lamports. We always do math in lamports with `bigint`, never with decimals (floats lose precision, and with money that's a bug).

**Wallet / keypair**: a public key (your address, like `7xKX...`) plus a secret key. Signing a transaction with the secret key proves you approved it.

**Accounts**: everything on Solana is an account. Your SOL balance, your USDC balance, a program's code, and a liquidity pool's state are all accounts.

**Tokens (SPL tokens)**: USDC, JUP and other tokens are not stored "in" your wallet. Each one lives in a separate **token account** owned by your wallet. The standard one is the **Associated Token Account (ATA)**, whose address is derived from `(your wallet, token mint)`. The **mint** is the token's ID. For example, the USDC mint is `EPjFWdd5...`.

**Rent**: accounts must hold a small SOL deposit (about 0.002 SOL for a token account). You get it back when you close the account. (See section 4 for why this matters for gas sponsorship.)

**Programs**: what Solana calls smart contracts. Jupiter, the Token Program, and the System Program are all programs. We only *call* programs; we don't write any here.

## 2. Transactions

A transaction is a list of **instructions** ("call program X with these accounts and this data") plus:

- **Fee payer**: the first signer, who pays the network fee. *This is the key to gas sponsorship.*
- **Signatures**: one from each required signer.
- **Recent blockhash**: a recent block ID. It acts like an expiry date. The transaction is only valid for about **150 blocks (roughly 60 to 90 seconds)**. After `lastValidBlockHeight` passes, it can never be processed.
- **Versioned (v0) transactions and Address Lookup Tables (ALTs)**: a transaction is limited to 1232 bytes. Jupiter routes touch many accounts, so v0 transactions refer to accounts through lookup tables to save space. See `compileToV0Message(lookupTables)` in `src/solana/txBuilder.ts`.

**Fees**:
- Base fee: 5,000 lamports per signature.
- **Priority fee**: an optional tip, `compute units × price in micro-lamports`. It makes validators include you first when the network is busy. It's set with the `ComputeBudgetProgram.setComputeUnitLimit` and `setComputeUnitPrice` instructions.
- Priority fees are *local*. A hot pool needs a higher tip, which is why we ask `getRecentPrioritizationFees` about our specific writable accounts.

**Commitment levels** (how sure you are a transaction is final):
- `processed`: one validator saw it (it could still be rolled back).
- `confirmed`: a supermajority voted on it. This is what we use; it's practically final.
- `finalized`: 31 or more blocks built on top. This is fully final.

**RPC**: your server talks to Solana through an RPC node (Helius, Triton, QuickNode). The public endpoint is heavily rate-limited, so production apps pay for one.

## 3. Jupiter: swap routing
Jupiter is an aggregator. You ask "swap 1 SOL to USDC" and it searches every exchange (Raydium, Orca, Meteora and others) for the best price, possibly splitting the trade across several routes.

1. `GET /quote` returns the route, the expected output, and `otherAmountThreshold` (the minimum output after slippage).
2. `POST /swap-instructions` returns the instructions to execute that route.

**Slippage**: the price can move between quoting and executing. `slippageBps=50` means "fail if I'd get more than 0.5% less than quoted". A failure there is a *program error*: the transaction lands, fails, and still costs the fee.

**Platform fee**: Jupiter lets an integrator take a fee (`platformFeeBps`) and send it to its own token account (`feeAccount`). That's how this app earns money. See `src/solana/jupiter.ts`.

## 4. Gas sponsorship ("gasless" swaps)
New users often have USDC but no SOL to pay fees. We make **our sponsor wallet the fee payer**, so the transaction has two signers: sponsor (fee payer) and user (owner of the tokens).

The flow (`src/trade/tradeService.ts`):
1. The server builds the transaction with `payerKey = sponsor` and saves a hash of the message.
2. The user signs in their wallet. Their signature only authorises moving *their* tokens.
3. The server checks that the message is byte-for-byte the one it built and that the user's signature is valid (`src/solana/verify.ts`).
4. The server simulates the transaction, then the sponsor signs and sends it.

**Why so many checks?** The sponsor's signature authorises the network to spend the sponsor's money. If an attacker could slip in "transfer 100 SOL from sponsor to me", the sponsor would sign it. So the sponsor must never appear in any instruction, and only known programs are allowed (`src/solana/sponsorPolicy.ts`). We also cap spend per wallet and per day (`src/trade/sponsorGuard.ts`), and we don't pay rent for the user's accounts. If we did, attackers could repeatedly make us create accounts and then close them to collect the deposit ("rent farming").

## 5. Landing transactions (the hardest part, and what interviewers probe)
"I sent it" does not mean it happened. Under load, RPC nodes drop transactions and validators skip them.

Our approach (`src/solana/sender.ts`):
1. Send with `skipPreflight: true, maxRetries: 0`. We've already simulated, and we want to control retries ourselves.
2. **Rebroadcast the exact same signed bytes** every 2 seconds. This is safe because Solana deduplicates by signature, so the same transaction can only execute once.
3. Poll `getSignatureStatuses`:
   - `confirmed` with no error means success.
   - `err` set means it landed but failed (slippage, for example). The fee was still paid, and the trade did not happen.
4. If block height is past `lastValidBlockHeight`, the transaction is **expired**: it can never land, so it is now safe to tell the user to try again.

**The trap to explain in the interview:** if you get a timeout and immediately build a *new* transaction with a *new* blockhash while the old one is still valid, both might land and the user swaps twice. You may only retry with a new blockhash *after* the old one has expired. That's why we track `lastValidBlockHeight`.

Other failure handling:
- The signature is saved to the DB **before** sending. If the server crashes, `recoverInFlight()` picks the transaction back up on restart.
- RPC 429s and timeouts are tolerated (the loop just polls again), and sends fan out to extra RPCs.
- "Blockhash not found" from a lagging RPC is not fatal; we keep trying until expiry.

## 6. Fee ledger (accounting)
Every money movement is a **double-entry journal**: debits equal credits, per token. If the numbers don't balance, something is wrong, and we find out immediately.

For a 1,000 USDC-unit fee with a 20% creator commission:

| account | amount |
| --- | --- |
| `platform:treasury:USDC` | +1000 (asset: what's in our fee account) |
| `platform:fee_revenue` | −800 (our income) |
| `creator:alice:payable` | −200 (what we owe Alice) |

Gas is a separate journal, and it's recorded even when the swap fails, because the fee was still spent. The relevant files are `src/ledger/journal.ts` and `src/ledger/ledgerRepo.ts`. Idempotency comes from `UNIQUE(trade_id, kind)`: settling the same trade twice books it once.

## 7. Creator commission
Creators (influencers or referrers) get a percentage *of our fee*, not of the trade. We round down so we never pay out more than we collected. The code is in `src/commission/commission.ts`.

## 8. Price pipeline
One server polls Jupiter's Price API every 2 seconds. It uses a Redis lock so only one server polls. It saves each price in Redis with a 60-second expiry, so stale prices disappear, and publishes it on a Redis channel. Every API server pushes the updates to its WebSocket clients. The code is in `src/prices/pricePipeline.ts`.

---

## Likely interview questions, with answers drawn from this code

**Q: How do you handle a transaction that doesn't confirm?**
I rebroadcast the same signed bytes every couple of seconds and poll its status until block height passes `lastValidBlockHeight`. Before that point I never retry with a new blockhash, because both could land. After expiry I know for certain it didn't happen, so the client can re-quote.

**Q: What is blockhash expiry?**
Every transaction includes a recent blockhash, and it's only valid for about 150 blocks (60 to 90 seconds). `getLatestBlockhash` returns `lastValidBlockHeight`. Once the chain passes it, the transaction is dead.

**Q: How do you make sure gas sponsorship can't be abused?**
The sponsor can only be the fee payer and can't be referenced in any instruction. Programs are allow-listed. The sponsor only signs the exact message hash we built. We simulate first, because failed transactions still cost fees. There are per-wallet and daily budgets in Redis, priority fees are capped, and the user pays rent so there's no rent farming. The key lives in Secrets Manager, and the hot wallet is kept small.

**Q: A transaction failed but the user was charged. What happened?**
On Solana a transaction can land with an error, such as slippage being exceeded. The program reverted, so no tokens moved, but the fee payer still paid the network fee. In our setup that's the sponsor, so we book gas expense but no revenue.

**Q: How do you pick priority fees?**
`getRecentPrioritizationFees` for the transaction's writable accounts, at the 75th percentile, capped by a maximum spend. The total is the compute-unit limit times the price per compute unit.

**Q: Why use `/swap-instructions` instead of `/swap`?**
So I can set our sponsor as fee payer, control the compute budget, and inspect every instruction before signing.

**Q: How do you keep the ledger correct under retries or crashes?**
The status update and ledger entries are written in one Postgres transaction, and a unique constraint on `(trade_id, kind)` makes settlement idempotent. Amounts are `NUMERIC` and `bigint`, never floats. A reconciliation query checks that every journal sums to zero, and we compare the treasury against on-chain balances.

**Q: Your RPC provider goes down. What happens?**
Status polls and sends tolerate errors. There are extra broadcast RPCs. Trades in flight either land or expire safely. The alarm on expiry rate fires, and the runbook says to add or switch providers.

**Q: What's the difference between confirmed and finalized?**
Confirmed means a supermajority of stake has voted on the block; it's practically never rolled back. Finalized means 31 or more blocks are built on top. For UX we use confirmed. For moving treasury funds, finalized is safer.

---

## Hands-on practice (do these before the interview)
1. Install the Solana CLI, run `solana-keygen new`, `solana config set --url devnet`, then `solana airdrop 1`.
2. Send yourself SOL with `solana transfer`, then look it up on https://explorer.solana.com/?cluster=devnet.
3. Run this project locally (see the README) and call `/v1/prices`.
4. With a throwaway mainnet wallet holding about $2 of SOL, run `scripts/demo-swap.ts` and open the transaction on Solscan. Find the fee payer, the compute budget instructions, the Jupiter instruction, and the fee transfer.
5. Read `npm test` output, then break something on purpose (for example, remove the sponsor check in `sponsorPolicy.ts`) and watch the tests catch it.
