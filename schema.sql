-- Illustrative PostgreSQL schema for a future regulated deployment.
-- This schema is NOT used by the in-memory demo. Do not treat it as a production wallet design.

CREATE TABLE app_users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telegram_user_id TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  age_verified_at TIMESTAMPTZ,
  jurisdiction_code CHAR(2),
  account_status TEXT NOT NULL DEFAULT 'pending' CHECK (account_status IN ('pending', 'active', 'restricted', 'closed'))
);

CREATE TABLE wallet_accounts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_users(id),
  currency_code CHAR(3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, currency_code)
);

-- Append-only ledger records. A real system needs reviewed double-entry accounting,
-- transactional idempotency, provider reconciliation, limits, AML controls and audit retention.
CREATE TABLE wallet_ledger_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wallet_account_id BIGINT NOT NULL REFERENCES wallet_accounts(id),
  transaction_id UUID NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('deposit', 'withdrawal', 'wager', 'payout', 'adjustment', 'reversal')),
  amount_minor BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'posted', 'reversed', 'failed')),
  provider_reference TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE game_rounds (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_users(id),
  game_code TEXT NOT NULL,
  wager_minor BIGINT NOT NULL CHECK (wager_minor >= 0),
  payout_minor BIGINT NOT NULL CHECK (payout_minor >= 0),
  outcome JSONB NOT NULL,
  rng_proof JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX wallet_ledger_account_created_idx ON wallet_ledger_entries(wallet_account_id, created_at DESC);
CREATE INDEX game_rounds_user_created_idx ON game_rounds(user_id, created_at DESC);
