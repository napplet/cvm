-- Phase 3 monetary authority. Apply through a PostgreSQL-wire migration runner.
CREATE TABLE funding_accounts (
  account_id text PRIMARY KEY,
  nostr_pubkey char(64) UNIQUE,
  unit text NOT NULL CHECK (unit = 'sat'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE funding_commands (
  account_id text NOT NULL REFERENCES funding_accounts(account_id),
  command_kind text NOT NULL,
  idempotency_key text NOT NULL,
  fingerprint_sha256 char(64) NOT NULL,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, command_kind, idempotency_key)
);
CREATE TABLE ledger_transactions (
  transaction_id text PRIMARY KEY,
  reference text UNIQUE NOT NULL,
  unit text NOT NULL CHECK (unit = 'sat'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ledger_entries (
  entry_id text PRIMARY KEY,
  transaction_id text NOT NULL REFERENCES ledger_transactions(transaction_id),
  account_id text NOT NULL REFERENCES funding_accounts(account_id),
  direction text NOT NULL CHECK (direction IN ('debit','credit')),
  amount bigint NOT NULL CHECK (amount > 0),
  unit text NOT NULL CHECK (unit = 'sat'),
  entry_reference text UNIQUE NOT NULL
);
CREATE TABLE account_balance_projection (
  account_id text PRIMARY KEY REFERENCES funding_accounts(account_id),
  unit text NOT NULL CHECK (unit = 'sat'),
  settled_available bigint NOT NULL DEFAULT 0 CHECK (settled_available >= 0),
  held bigint NOT NULL DEFAULT 0 CHECK (held >= 0)
);
CREATE TABLE cashu_policy_versions (policy_version text PRIMARY KEY, immutable_hash char(64) UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE cashu_mints (policy_version text NOT NULL REFERENCES cashu_policy_versions(policy_version), mint_url text NOT NULL, keyset_id text NOT NULL, unit text NOT NULL CHECK (unit = 'sat'), PRIMARY KEY(policy_version, mint_url, keyset_id));
CREATE TABLE top_ups (top_up_id text PRIMARY KEY, account_id text NOT NULL REFERENCES funding_accounts(account_id), rail text NOT NULL CHECK (rail IN ('lightning','cashu')), amount bigint NOT NULL CHECK (amount > 0), unit text NOT NULL CHECK (unit = 'sat'), state text NOT NULL CHECK (state IN ('pending','verifying','settled','credited','failed','reconciliation_pending')), settlement_reference text UNIQUE NOT NULL, policy_version text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE settlement_attempts (attempt_id text PRIMARY KEY, top_up_id text NOT NULL REFERENCES top_ups(top_up_id), external_reference text UNIQUE NOT NULL, proof_commitment char(64) UNIQUE, observed_state text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE protected_rail_material (material_id text PRIMARY KEY, top_up_id text NOT NULL REFERENCES top_ups(top_up_id), ciphertext bytea NOT NULL, ciphertext_sha256 char(64) NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE session_cap_holds (hold_id text PRIMARY KEY, account_id text NOT NULL REFERENCES funding_accounts(account_id), reference text UNIQUE NOT NULL, requested_cap bigint NOT NULL CHECK (requested_cap > 0), held_amount bigint NOT NULL CHECK (held_amount > 0), state text NOT NULL CHECK (state IN ('active','released','consumed')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE admissions (admission_id text PRIMARY KEY, account_id text NOT NULL REFERENCES funding_accounts(account_id), reference text UNIQUE NOT NULL, capacity_reference text NOT NULL, state text NOT NULL CHECK (state IN ('accepted','refused','reconciliation_pending')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE capacity_intents (intent_id text PRIMARY KEY, account_id text NOT NULL REFERENCES funding_accounts(account_id), idempotency_key text NOT NULL, fingerprint_sha256 char(64) NOT NULL, intent_reference text UNIQUE NOT NULL, capacity_reference text, expires_at timestamptz, state text NOT NULL CHECK (state IN ('created','dispatching','available','refused','reconciliation_pending','released')), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id, idempotency_key));
CREATE TABLE action_budget_reservations (reservation_id text PRIMARY KEY, account_id text NOT NULL REFERENCES funding_accounts(account_id), admission_reference text NOT NULL REFERENCES admissions(reference), idempotency_key text NOT NULL, fingerprint_sha256 char(64) NOT NULL, reservation_reference text UNIQUE NOT NULL, amount bigint NOT NULL CHECK (amount > 0), unit text NOT NULL CHECK (unit = 'sat'), state text NOT NULL CHECK (state = 'authorized'), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id, idempotency_key));
CREATE TABLE treasury_reconciliation (reconciliation_id text PRIMARY KEY, top_up_id text UNIQUE NOT NULL REFERENCES top_ups(top_up_id), state text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
-- Rail coordinators persist opaque, redacted lifecycle state separately from the
-- monetary projection. These are the durable replay authorities for provider I/O.
CREATE TABLE lightning_top_up_state (state_key text PRIMARY KEY, state_json jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE cashu_top_up_state (top_up_id text PRIMARY KEY, proof_commitment char(64) UNIQUE NOT NULL, state_json jsonb NOT NULL, treasury_json jsonb, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE funding_outbox (outbox_id text PRIMARY KEY, aggregate_reference text NOT NULL, event_kind text NOT NULL, payload_json jsonb NOT NULL, state text NOT NULL DEFAULT 'pending', UNIQUE (aggregate_reference, event_kind));
-- The runner MUST issue SET TRANSACTION ISOLATION LEVEL SERIALIZABLE before mutations.
-- No generation-work queue exists in this schema; outbox records payment/reconciliation effects only.
