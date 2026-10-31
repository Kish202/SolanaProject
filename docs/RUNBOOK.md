# Runbook

Dashboards: CloudWatch `SolanaTrade` namespace, Elastic Beanstalk enhanced health, Supabase dashboard (Database → Reports), `/metrics` (Prometheus).
Logs: CloudWatch log group `/aws/elasticbeanstalk/solana-trade-api/var/log/web.stdout.log` (JSON). On Render, use the service's Logs tab. Useful Logs Insights queries are below.

```
# outcomes in the last hour
fields @timestamp, tradeId, status, elapsedMs, rebroadcasts
| filter event = "trade_landed" | stats count() by status
```

---

## Alert: Sponsor balance low
**Impact:** when the sponsor runs out of SOL, every swap fails at submission.

1. Check the balance: `solana balance <SPONSOR_PUBKEY> --url <RPC>`.
2. Top it up from the treasury or cold wallet (needs two-person approval). Send at least 3 days of average spend, which you can see in `sponsor_spend_lamports_total`.
3. If spend is abnormal, check for abuse: find the wallets with the most trades in the last hour.
   ```sql
   SELECT wallet, count(*) FROM trades WHERE created_at > now() - interval '1 hour' GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
   ```
   Lower `SPONSOR_MAX_TX_PER_WALLET_PER_HOUR` or block the wallet if needed.

## Alert: Transactions not landing (high expiry rate)
**Symptoms:** many trades end as `expired`, and `trade_tx_landing_seconds` is rising.

1. Is the network congested? Check https://status.solana.com and recent priority fees.
2. Is the RPC healthy? Watch `rpc_errors_total` by method. 429 errors mean you're rate limited, so upgrade the plan or add a broadcast RPC.
3. Is the priority fee too low? If p75 fees are above our cap, raise `PRIORITY_FEE_MAX_LAMPORTS`. That raises sponsor spend, so check the daily budget.
4. Add a staked or second provider to `SOLANA_SEND_RPC_URLS`, then redeploy.
5. Expired trades are **safe**: nothing happened on-chain, and users just re-quote. No ledger action is needed.

## Trades stuck in `submitted`
This should be impossible for more than about 90 seconds, because blockhashes expire.

1. `SELECT id, signature, updated_at FROM trades WHERE status = 'submitted' AND updated_at < now() - interval '5 minutes';`
2. Look each signature up on https://solscan.io/tx/<signature>.
3. Restarting a task triggers `recoverInFlight`, which re-runs the landing loop and settles them. **Never** mark one `expired` by hand without first checking that block height is past `last_valid_block_height`. If it actually landed, you'd lose ledger entries.

## Ledger doesn't reconcile
1. Find unbalanced journals (this should return 0 rows):
   ```sql
   SELECT journal_id FROM ledger_entries GROUP BY journal_id, mint HAVING SUM(amount) <> 0;
   ```
2. Compare the treasury in the books with what's on-chain:
   ```sql
   SELECT mint, SUM(amount) FROM ledger_entries WHERE account LIKE 'platform:treasury:%' GROUP BY 1;
   ```
   Compare that with `spl-token balance --address <fee ATA>`. Small differences can come from quotes where the actual output differed from the quote. Larger ones need to be investigated per trade with `getTransaction` and the `postTokenBalances` of the fee account.
3. Never update or delete ledger rows. Correct mistakes with a new adjusting journal.

## Jupiter errors / "no route available"
- 503 `routing` errors are retryable. Check https://status.jup.ag.
- 503 `rate_limited` means Jupiter returned 429. The free lite-api quota is shared by the price poller and
  quotes: raise `PRICE_POLL_MS` (default 10000) or set `JUPITER_API_KEY` with the `api.jup.ag` URLs.
- 422 errors for a specific pair usually mean the token has no liquidity, so this isn't an incident.

## Suspected sponsor key compromise
1. **Immediately** stop the API. On AWS: `aws elasticbeanstalk update-environment --environment-name solana-trade-api --option-settings Namespace=aws:autoscaling:asg,OptionName=MinSize,Value=0 Namespace=aws:autoscaling:asg,OptionName=MaxSize,Value=0`. On Render: the service's Settings, then **Suspend**.
2. Move the remaining SOL out of the sponsor wallet to a safe address (the attacker is racing you).
3. Generate a new key (`npm run gen:sponsor-key`), update the Secrets Manager value, fund it with a small amount, and scale back up.
4. Rotate `ADMIN_API_KEY` and audit CloudTrail for `GetSecretValue` calls.

## Deploys and rollback
- Merging to `main` runs tests, then (on AWS) uploads a Node bundle to Elastic Beanstalk. Deploys are **immutable**: new instances must pass `/readyz` before they get traffic, otherwise Beanstalk discards them and keeps the old ones. Render redeploys automatically on push.
- Migrations run at startup (`npm run start:prod`) under a Postgres advisory lock, so instances booting together don't race.
- For a manual rollback on AWS: `aws elasticbeanstalk update-environment --environment-name solana-trade-api --version-label <previous-version>`. On Render: the service's Events tab, then **Rollback** on an earlier deploy.
- Migrations must stay backward compatible (add first, remove later), because old and new instances run side by side during a deploy.

## Database (Supabase) unreachable
**Symptoms:** `/readyz` returns 503, and logs show `ECONNREFUSED`, `ETIMEDOUT` or `too many connections`.

1. Check https://status.supabase.com and the project's dashboard. Free projects **pause after a week of inactivity**; click **Restore** if so.
2. Use the **Session pooler** connection string (IPv4). The direct connection is IPv6-only and fails from Render and most AWS setups.
3. `too many connections`: lower the pool size in `src/db/pool.ts`, or upgrade the Supabase plan. Each API instance uses up to 10 connections.
4. Trades in flight during a database outage keep landing on-chain. When the database is back, restart the API so `recoverInFlight` settles them into the ledger.

## Redis unreachable (`ECONNREFUSED`, `MaxRetriesPerRequestError`)

- `REDIS_URL` must be your provider's URL (Render: Key Value, then Connect, then Internal URL, in the same region as the API).
- A `localhost` `REDIS_URL` on a hosted server is ignored, and the API falls back to in-memory Redis with a warning.
- In-memory mode keeps rate limits, the sponsor budget and the price lock inside one process. Use real Redis before running more than one instance.

## Dependency audit

- The backend has 0 known vulnerabilities (`npm audit`). `@solana/spl-token` was dropped (its `bigint-buffer` has no fix); token program IDs and associated token account derivation live in `src/solana/tokenPrograms.ts`.
- `jayson` (inside `@solana/web3.js`) is overridden to patched `uuid` and `stream-json`, in both the backend and `web/`.
- `web/` still reports moderate `minimatch` advisories from ESLint plugins. They are dev-only and never shipped; the fixed `minimatch` 11 is not compatible with those plugins yet.
