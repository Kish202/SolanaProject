# Deploying (free tier, no Docker)

| Part | Host | Folder |
| --- | --- | --- |
| Frontend (Next.js) | Vercel | `web/` |
| Backend API | Render (native Node runtime) | repo root |
| Postgres | Supabase | tables created by `npm run migrate` |
| Redis | Render Key Value | created by `render.yaml`. Optional: with no `REDIS_URL` the API uses in-memory Redis (fine for one instance) |

Free-tier caveats:
- Render's free web service **sleeps after 15 minutes without traffic** and takes about a minute to wake up. Open the site a few minutes before a demo.
- Supabase's free project **pauses after about a week with no activity**. Open the Supabase dashboard the day before the interview and click **Restore** if it's paused.
- The production design (Elastic Beanstalk on the Node.js platform, ElastiCache, Secrets Manager, alarms) is in `infra/terraform/`. Render is the low-cost demo deployment.

---

## 0. Before you start

1. **Push this folder to GitHub** (Render and Vercel deploy from GitHub). Check that `.env` is **not** committed (`git status` should not list it).
2. **Get an RPC URL.** The public `https://api.mainnet-beta.solana.com` is heavily rate-limited. Sign up at https://helius.dev (free) and copy your mainnet URL.
3. **Create the sponsor wallet** (it pays everyone's gas):
   ```bash
   npm run gen:sponsor-key
   ```
   Save the printed `SPONSOR_SECRET_KEY` somewhere safe, then send about 0.05 SOL to the printed public key. That covers hundreds of swaps.
4. **Pick a fee wallet** (`PLATFORM_FEE_OWNER`). Use your own Phantom address. To actually collect fees in USDC, that wallet needs a USDC token account; receiving any USDC once creates it. Without one, swaps still work and the fee is just 0%.

## 1. Database on Supabase

1. Go to https://supabase.com/dashboard, click **New project**, and pick the region closest to your Render region (for example Singapore or Mumbai). **Save the database password** you set.
2. Click **Connect** at the top of the project, and copy the **Session pooler** connection string. It looks like:
   ```
   postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   ```
   Use the session pooler, not the direct connection: the direct one is IPv6-only and won't work from Render.
3. Put it in your local `.env` as `DATABASE_URL` (with your real password), then create the tables:
   ```bash
   npm run migrate
   ```
   In Supabase's **Table Editor** you should now see `trades`, `creators`, `ledger_journals` and `ledger_entries`, each marked with RLS enabled. That's intentional: it stops Supabase's public REST API from touching your money tables.

## 2. Backend on Render

1. Go to https://dashboard.render.com, then **New**, then **Blueprint**, and connect the GitHub repo. Render reads `render.yaml` and creates the API and Redis.
2. When prompted, fill in:
   - `DATABASE_URL`: the Supabase session pooler string from step 1
   - `SPONSOR_SECRET_KEY`: from step 0.3
   - `PLATFORM_FEE_OWNER`: from step 0.4
   - `SOLANA_RPC_URL`: your Helius URL
   - `CORS_ORIGINS`: leave as `http://localhost:3000` for now; you'll update it after step 3
3. Click **Apply** and wait for the deploy (about 5 minutes). Migrations also run at startup, so you never have to run them by hand on the server.
4. Check that it works (use your service URL):
   ```bash
   curl https://solana-trade-api.onrender.com/readyz      # {"ok":true}
   curl https://solana-trade-api.onrender.com/v1/prices
   ```

## 3. Frontend on Vercel

1. Go to https://vercel.com/new and import the same repo.
2. Set **Root Directory** to `web`. Vercel detects Next.js automatically.
3. Add the environment variables:
   - `NEXT_PUBLIC_API_URL` = `https://solana-trade-api.onrender.com` (no trailing slash)
   - `NEXT_PUBLIC_SOLANA_RPC_URL` = your Helius URL (optional)
4. Click **Deploy**. You'll get a URL like `https://solana-trade.vercel.app`.

## 4. Connect them

On Render, go to the API service, then **Environment**, and set:

```
CORS_ORIGINS=https://solana-trade.vercel.app,http://localhost:3000
```

Save it; Render redeploys. Open the Vercel URL. The header should say **API online**, and prices should say **Live · WebSocket**.

## 5. Test a real swap

1. Install Phantom, create a wallet, and put about $2 of USDC or SOL in it.
2. Open your Vercel URL, click **Select Wallet**, and choose Phantom.
3. Swap a tiny amount (for example 1 USDC to SOL). Phantom shows a request to sign; the network fee is paid by your sponsor wallet.
4. Click **View on Solscan**. On the transaction page, the **fee payer** is your sponsor address, not your Phantom wallet. That's the gas sponsorship working.
5. In Supabase's Table Editor, open `ledger_entries` to see the gas and fee journals the trade created.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Header says "API offline" | Render is waking up (wait about 60 seconds), or `NEXT_PUBLIC_API_URL` is wrong. Redeploy Vercel after changing it, because `NEXT_PUBLIC_` values are baked in at build time. |
| Render logs show `ENOTFOUND` or `ENETUNREACH` for the database | You used Supabase's direct connection string. Switch to the **Session pooler** string. |
| `password authentication failed` | Wrong password in `DATABASE_URL`. You can reset it in Supabase under Database settings. |
| `/readyz` returns 503 after days of no use | The Supabase project paused. Restore it from the dashboard. |
| Browser console shows a CORS error | `CORS_ORIGINS` on Render must exactly match your Vercel URL (https, no trailing slash) |
| "transaction simulation failed" | The wallet doesn't have enough of the input token, or the price moved. Increase slippage to 1%. |
| "sponsor daily budget exhausted" or "hourly limit" | Abuse limits are working; see `SPONSOR_*` variables in `.env.example` |
| Trades end as `expired` | The RPC is congested or rate-limited. Use a Helius URL instead of the public RPC. |
| Render deploy fails on startup | Check the logs. Usually a missing env var; the config validator prints exactly which one. |
