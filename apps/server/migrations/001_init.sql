-- MAYBE schema v1. Amounts are numeric(20,0) (u64 range), never floats.
-- Status columns hold values from packages/core/src/state-machines.ts only.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  address text PRIMARY KEY,                -- wallet public key (base58)
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- Sign-In-With-Solana style challenges: single use, domain bound, expiring.
CREATE TABLE auth_challenges (
  nonce text PRIMARY KEY,
  address text NOT NULL,
  domain text NOT NULL,
  message text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX auth_challenges_expiry ON auth_challenges (expires_at);

-- Sessions store only a hash of the bearer token.
CREATE TABLE wallet_sessions (
  token_hash text PRIMARY KEY,
  address text NOT NULL REFERENCES users(address),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  user_agent text
);

-- Canonical event registry (venue identity + frozen rule version + on-chain account).
CREATE TABLE markets (
  key text PRIMARY KEY,
  venue text NOT NULL,
  venue_market_id text NOT NULL,
  event_account text NOT NULL UNIQUE,
  rule_hash text NOT NULL,
  title text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('binary', 'multi', 'scalar')),
  adapter text NOT NULL CHECK (adapter IN ('attestation', 'balance-threshold')),
  meta jsonb NOT NULL DEFAULT '{}',
  UNIQUE (venue, venue_market_id, rule_hash)
);

CREATE TABLE rule_versions (
  rule_hash text PRIMARY KEY,
  venue text NOT NULL,
  venue_market_id text NOT NULL,
  rules text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- Strategy documents. Every authorized version is immutable; edits create a new row.
CREATE TABLE strategies (
  id text PRIMARY KEY,
  owner text NOT NULL REFERENCES users(address),
  version int NOT NULL,
  title text NOT NULL,
  status text NOT NULL,
  doc jsonb NOT NULL,
  plan_hash text,
  plan_bytes bytea,
  strategy_account text UNIQUE,
  strategy_seed numeric(20,0),             -- the u64 strategy_id in the PDA seeds
  signed_at bigint,
  via_policy text,
  supersedes text,
  sample boolean NOT NULL DEFAULT false,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX strategies_owner ON strategies (owner, updated_at DESC);

-- Authorizations: the exact bytes and the transactions that carried them.
CREATE TABLE authorizations (
  id bigserial PRIMARY KEY,
  strategy_id text NOT NULL REFERENCES strategies(id),
  plan_hash text NOT NULL,
  signer text NOT NULL,
  via_policy text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (strategy_id, plan_hash)
);

-- Projections of on-chain state, written only by the indexer.
CREATE TABLE vault_projections (
  vault text PRIMARY KEY,
  owner text NOT NULL,
  policy_epoch int NOT NULL,
  balances jsonb NOT NULL,                 -- mint -> {available, reserved} as strings
  token_balances jsonb NOT NULL,           -- mint -> actual token account amount
  slot bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE strategy_projections (
  strategy_account text PRIMARY KEY,
  vault text NOT NULL,
  status text NOT NULL,
  state jsonb NOT NULL,                    -- holdings, claims, action runtime (bigints as strings)
  slot bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event_projections (
  event_account text PRIMARY KEY,
  adapter text NOT NULL,
  status text NOT NULL,
  outcome text,
  final_at bigint,
  proposed_at bigint,
  deadline bigint,
  slot bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Immutable execution receipts parsed from confirmed transaction logs.
-- (strategy, action, run) is unique on-chain too: the program rejects a run that already happened.
CREATE TABLE receipts (
  strategy_account text NOT NULL,
  action int NOT NULL,
  run int NOT NULL,
  signature text NOT NULL,
  plan_hash text NOT NULL,
  kind int NOT NULL,
  skipped_runs int NOT NULL,
  exec_nonce bigint NOT NULL,
  at bigint NOT NULL,
  amount numeric(20,0) NOT NULL,
  fee numeric(20,0) NOT NULL,
  amount_in numeric(20,0) NOT NULL,
  amount_out numeric(20,0) NOT NULL,
  in_mint text NOT NULL,
  out_mint text,
  recipient text,
  slot bigint NOT NULL,
  PRIMARY KEY (strategy_account, action, run)
);

-- Intents: what someone asked the system to do, keyed by an idempotency key.
CREATE TABLE intents (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  kind text NOT NULL,                      -- deposit | withdraw | authorize | pause | cancel | policy-create | policy-revoke | kill-switch
  actor text NOT NULL,                     -- the signer the transactions were built for
  owner text NOT NULL,
  strategy_id text,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'BUILT',     -- BUILT | SUBMITTING | DONE | FAILED
  error text,
  runner text,                             -- lease: whoever is sending this intent's transactions
  lease_until timestamptz,
  effects_applied int[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intents_owner ON intents (owner, created_at DESC);

-- Transactions and their observed lifecycle (txMachine states). Sent strictly in seq order.
CREATE TABLE transactions (
  id text PRIMARY KEY,
  intent_id text NOT NULL REFERENCES intents(id),
  seq int NOT NULL,
  label text NOT NULL,
  effect text,
  message bytea NOT NULL,                  -- exact bytes the signer signs
  signed_tx bytea,
  signature text UNIQUE,
  state text NOT NULL DEFAULT 'BUILT',
  blockhash text NOT NULL,
  last_valid_block_height bigint NOT NULL,
  error text,
  slot bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intent_id, seq)
);
CREATE INDEX transactions_open ON transactions (state) WHERE state IN ('SIGNED', 'SUBMITTED', 'PROCESSED');

-- Durable job queue. A queue alone can't guarantee exactly-once spending:
-- execute jobs carry (strategy, action, run) and the program rejects a run that already happened.
CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED',
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 8,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready ON jobs (state, run_at) WHERE state IN ('QUEUED', 'RETRY_WAIT');

-- Transactional outbox for live updates (fanned out over SSE via LISTEN/NOTIFY).
CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  topics text[] NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activity (
  id bigserial PRIMARY KEY,
  dedupe_key text UNIQUE,
  owner text,
  at bigint NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  detail text,
  amounts jsonb,
  strategy_id text,
  market_key text,
  signature text,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_owner ON activity (owner, at DESC);

-- Agent sessions and capability policies (the policy itself lives on-chain).
CREATE TABLE agent_sessions (
  id text PRIMARY KEY,
  owner text NOT NULL,
  role text NOT NULL,
  title text NOT NULL,
  provider text NOT NULL,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  conversation jsonb NOT NULL DEFAULT '{}',
  steps jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_policies (
  policy_account text PRIMARY KEY,
  owner text NOT NULL,
  vault text NOT NULL,
  label text NOT NULL,
  session_key text NOT NULL,
  limits jsonb NOT NULL,                   -- what was requested (the program's copy is authoritative)
  state jsonb,                             -- projection of the on-chain policy account
  confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE agent_audit (
  id bigserial PRIMARY KEY,
  session_id text,
  at timestamptz NOT NULL DEFAULT now(),
  event text NOT NULL,
  detail jsonb NOT NULL              -- already redacted by @maybe/agent
);

-- Future Rooms: immutable published versions.
CREATE TABLE rooms (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  author text NOT NULL,
  owner text,
  source_doc_id text,
  sample boolean NOT NULL DEFAULT false,
  record jsonb NOT NULL DEFAULT '{"kind":"none","note":"No track record.","outcomes":[]}',
  copies int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE room_versions (
  room_id text NOT NULL REFERENCES rooms(id),
  version int NOT NULL,
  doc jsonb NOT NULL,
  plan_hash text NOT NULL,
  thesis text NOT NULL,
  risk jsonb NOT NULL DEFAULT '[]',
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, version)
);

CREATE TABLE reconciliation_runs (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  scope text NOT NULL,
  ok boolean NOT NULL,
  detail text NOT NULL
);

-- Small singletons the indexer maintains (chain clock, config flags, pool reserves, keeper heartbeat).
CREATE TABLE kv (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_limits (
  bucket text PRIMARY KEY,
  tokens double precision NOT NULL,
  refreshed_at timestamptz NOT NULL
);
