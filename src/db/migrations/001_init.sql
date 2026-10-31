-- Creators earn a share of the platform fee on trades they refer.
CREATE TABLE IF NOT EXISTS creators (
  id              TEXT PRIMARY KEY,
  payout_wallet   TEXT NOT NULL,
  -- share of the PLATFORM fee (not of the trade), in bps. 2000 = 20% of platform fee.
  commission_bps  INTEGER NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE trade_status AS ENUM (
  'built',      -- tx built, waiting for the user's signature
  'submitted',  -- user-signed tx received, being sent
  'confirmed',  -- landed and succeeded on-chain
  'failed',     -- landed but the program returned an error (fee was still paid)
  'expired'     -- blockhash expired before landing; nothing happened on-chain
);

CREATE TABLE IF NOT EXISTS trades (
  id                      UUID PRIMARY KEY,
  wallet                  TEXT NOT NULL,
  creator_id              TEXT REFERENCES creators(id),
  input_mint              TEXT NOT NULL,
  output_mint             TEXT NOT NULL,
  in_amount               NUMERIC(40,0) NOT NULL,
  quoted_out_amount       NUMERIC(40,0) NOT NULL,
  slippage_bps            INTEGER NOT NULL,
  platform_fee_bps        INTEGER NOT NULL,
  platform_fee_mint       TEXT,
  platform_fee_amount     NUMERIC(40,0) NOT NULL DEFAULT 0,
  -- sha256 of the exact message bytes we built; the sponsor only signs messages that match.
  message_hash            TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  status                  trade_status NOT NULL DEFAULT 'built',
  signature               TEXT UNIQUE,
  -- fully signed tx bytes (base64), kept so a restarted worker can keep rebroadcasting until expiry
  signed_tx               TEXT,
  network_fee_lamports    BIGINT,
  error                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trades_wallet_created_idx ON trades (wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS trades_status_idx ON trades (status) WHERE status IN ('built', 'submitted');

-- Double-entry fee ledger. Every journal must sum to zero per mint.
CREATE TABLE IF NOT EXISTS ledger_journals (
  id          UUID PRIMARY KEY,
  trade_id    UUID REFERENCES trades(id),
  kind        TEXT NOT NULL,
  -- one journal per (trade, kind): makes ledger writes idempotent on retries
  UNIQUE (trade_id, kind),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id          BIGSERIAL PRIMARY KEY,
  journal_id  UUID NOT NULL REFERENCES ledger_journals(id),
  account     TEXT NOT NULL,
  mint        TEXT NOT NULL,
  -- positive = debit, negative = credit, in the mint's smallest unit
  amount      NUMERIC(40,0) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_entries_account_idx ON ledger_entries (account, mint);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name        TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
