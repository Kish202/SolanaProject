# Architecture and design decisions

## Components

- **API (Fastify)**: stateless Node process. On AWS it runs on 2 or more Elastic Beanstalk instances behind an ALB; for the demo it runs on Render.
- **Postgres (Supabase)**: source of truth for trades, creators and the fee ledger. Connected through Supabase's IPv4 session pooler over TLS. Row Level Security is enabled on every table with no policies, so Supabase's public REST API can't read or write them; only the backend's database role can.
- **Redis (ElastiCache)**: latest prices, price pub/sub fan-out, sponsor rate limits and daily budget, and the price-poller leader lock.
- **Solana RPC**: a primary paid provider for reads and status, plus optional extra endpoints used only to broadcast.
- **Jupiter API**: route finding and swap instructions, and the price feed.

## Key decisions

### 1. Build the transaction ourselves (`/swap-instructions`, not `/swap`)
Jupiter's `/swap` returns a fully built transaction where the user is the fee payer. To sponsor gas we need the **sponsor as fee payer**, our own compute-budget instructions, and a security check on every instruction. So we fetch the raw instructions and compile a v0 transaction with Jupiter's address lookup tables.

### 2. Gas sponsorship without getting drained
Signing as fee payer authorises the network to charge the sponsor. The attack surface is:

| Attack | Defence |
| --- | --- |
| A message that makes the sponsor transfer SOL or act as an authority | `assertSponsorable`: the sponsor may not appear in **any** instruction, and only allow-listed programs are permitted |
| The user signs a different message than the one we approved | We store `sha256(message)` at quote time; `verifyUserSignedTx` requires an exact match |
| Spamming failing transactions (failed txs still cost the fee payer) | Simulate before co-signing; per-wallet hourly cap; global daily lamport budget (Redis) |
| Rent farming (the sponsor pays rent for accounts the user later closes to reclaim the SOL) | The user pays rent for their token accounts; the sponsor pays only signature and priority fees |
| Huge priority fees | Priority fee is computed by us and capped at `PRIORITY_FEE_MAX_LAMPORTS` |
| Key theft | Key loaded from Secrets Manager; the hot wallet holds only a few days of gas, topped up from cold storage |

### 3. Landing transactions reliably
- Send with `skipPreflight: true, maxRetries: 0` (we simulate ourselves, and we own the retry loop).
- **Rebroadcast the same signed bytes** every 2 seconds. This is safe because a signature can only be processed once.
- Poll `getSignatureStatuses`. Once confirmed, done. If it landed with `err`, that's a definitive failure (the fee was still paid).
- **Blockhash expiry is the only safe "it didn't happen" signal.** When block height passes `lastValidBlockHeight`, the transaction can never land, so we mark it `expired` and the client can re-quote. Retrying with a *new* blockhash before that point could execute the trade twice.
- The signature is persisted **before** the first broadcast, along with the signed bytes, so a restarted process resumes the loop (`recoverInFlight`).
- The priority fee comes from `getRecentPrioritizationFees` for the transaction's writable accounts (75th percentile), because fees are local to hot accounts.

### 4. Fee ledger
Double entry, integer amounts in base units (`NUMERIC(40,0)` and `bigint`; never floats).

| Event | Debit | Credit |
| --- | --- | --- |
| Gas paid (every landed tx, including failed ones) | `platform:gas_expense` | `sponsor:wallet` |
| Swap fee collected | `platform:treasury:<mint>` | `platform:fee_revenue` and `creator:<id>:payable` |

- The trade status update and the ledger journals are written in **one DB transaction**.
- `UNIQUE (trade_id, kind)` makes settlement idempotent, so retries can't double-book.
- `findUnbalancedJournals` is the reconciliation check. Also reconcile `platform:treasury:<mint>` against the on-chain fee account balance (see the runbook).

### 5. Creator commission
The creator gets `commission_bps` **of the platform fee** (not of the trade volume), rounded down, with the remainder going to the platform. This guarantees the sum of payouts never exceeds the fees actually collected. Payouts are a separate batch job that debits `creator:<id>:payable` when the on-chain transfer confirms (a next step).

### 6. Price pipeline
One poller (Redis `SET NX PX` leader lock) fetches the Jupiter Price API and writes `price:<mint>` with a 60-second TTL. That TTL means stale prices disappear instead of being served. The poller publishes only when the price moved at least 1 bps. Every API pod subscribes to the Redis channel and pushes to its own WebSocket clients, so it scales horizontally.

## What I'd add next
- A payout worker for creator commissions, with on-chain reconciliation.
- Jito bundles or a staked-connection RPC for better landing during congestion.
- An outbox table and queue (SQS) for the landing loop instead of in-process promises.
- Integration tests against `solana-test-validator` with cloned mainnet accounts.
- Signing the sponsor key with KMS or an HSM-backed signer instead of an in-memory key.
