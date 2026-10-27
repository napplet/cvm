-- Phase 07: preserve private test history while creating a zero-funded
-- production monetary authority. Apply as a privileged, additive PostgreSQL
-- migration; application connections receive only the realm role below.
DO $$ BEGIN CREATE ROLE napplet_development_history NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE napplet_production_real NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Legacy/private rows retain their exact values and become explicitly inert for
-- real money. These checks also stop a later UPDATE from relabelling history.
ALTER TABLE funding_accounts ADD COLUMN IF NOT EXISTS accounting_realm text NOT NULL DEFAULT 'development-test' CHECK (accounting_realm = 'development-test');
ALTER TABLE funding_commands ADD COLUMN IF NOT EXISTS accounting_realm text NOT NULL DEFAULT 'development-test' CHECK (accounting_realm = 'development-test');
ALTER TABLE ledger_transactions ADD COLUMN IF NOT EXISTS accounting_realm text NOT NULL DEFAULT 'development-test' CHECK (accounting_realm = 'development-test');
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS accounting_realm text NOT NULL DEFAULT 'development-test' CHECK (accounting_realm = 'development-test');
ALTER TABLE account_balance_projection ADD COLUMN IF NOT EXISTS accounting_realm text NOT NULL DEFAULT 'development-test' CHECK (accounting_realm = 'development-test');
ALTER TABLE top_ups ADD COLUMN IF NOT EXISTS accounting_realm text NOT NULL DEFAULT 'development-test' CHECK (accounting_realm = 'development-test');
ALTER TABLE settlement_attempts ADD COLUMN IF NOT EXISTS accounting_realm text NOT NULL DEFAULT 'development-test' CHECK (accounting_realm = 'development-test');
ALTER TABLE session_cap_holds ADD COLUMN IF NOT EXISTS accounting_realm text NOT NULL DEFAULT 'development-test' CHECK (accounting_realm = 'development-test');
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS accounting_realm text NOT NULL DEFAULT 'development-test' CHECK (accounting_realm = 'development-test');
ALTER TABLE action_budget_reservations ADD COLUMN IF NOT EXISTS accounting_realm text NOT NULL DEFAULT 'development-test' CHECK (accounting_realm = 'development-test');

CREATE SCHEMA IF NOT EXISTS production_real AUTHORIZATION CURRENT_USER;
REVOKE ALL ON SCHEMA public FROM napplet_production_real;
REVOKE ALL ON SCHEMA production_real FROM PUBLIC, napplet_development_history;
GRANT USAGE ON SCHEMA public TO napplet_development_history;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO napplet_development_history;
GRANT USAGE ON SCHEMA production_real TO napplet_production_real;

CREATE TABLE IF NOT EXISTS production_real.funding_accounts (
  account_id text PRIMARY KEY, nostr_pubkey char(64) UNIQUE, unit text NOT NULL CHECK (unit='sat'),
  accounting_realm text NOT NULL DEFAULT 'production-real' CHECK (accounting_realm='production-real'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS production_real.funding_commands (
  account_id text NOT NULL REFERENCES production_real.funding_accounts(account_id), command_kind text NOT NULL, idempotency_key text NOT NULL,
  fingerprint_sha256 char(64) NOT NULL, result_json jsonb NOT NULL, accounting_realm text NOT NULL DEFAULT 'production-real' CHECK (accounting_realm='production-real'), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,command_kind,idempotency_key)
);
CREATE TABLE IF NOT EXISTS production_real.ledger_transactions (
  transaction_id text PRIMARY KEY, reference text UNIQUE NOT NULL, unit text NOT NULL CHECK(unit='sat'), accounting_realm text NOT NULL DEFAULT 'production-real' CHECK(accounting_realm='production-real'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS production_real.ledger_entries (
  entry_id text PRIMARY KEY, transaction_id text NOT NULL REFERENCES production_real.ledger_transactions(transaction_id), account_id text NOT NULL REFERENCES production_real.funding_accounts(account_id),
  direction text NOT NULL CHECK(direction IN ('debit','credit')), amount bigint NOT NULL CHECK(amount>0), unit text NOT NULL CHECK(unit='sat'), entry_reference text UNIQUE NOT NULL,
  accounting_realm text NOT NULL DEFAULT 'production-real' CHECK(accounting_realm='production-real')
);
CREATE TABLE IF NOT EXISTS production_real.account_balance_projection (
  account_id text PRIMARY KEY REFERENCES production_real.funding_accounts(account_id), unit text NOT NULL CHECK(unit='sat'), settled_available bigint NOT NULL DEFAULT 0 CHECK(settled_available>=0), held bigint NOT NULL DEFAULT 0 CHECK(held>=0),
  accounting_realm text NOT NULL DEFAULT 'production-real' CHECK(accounting_realm='production-real')
);
CREATE TABLE IF NOT EXISTS production_real.top_ups (
  top_up_id text PRIMARY KEY, account_id text NOT NULL REFERENCES production_real.funding_accounts(account_id), rail text NOT NULL CHECK(rail IN ('lightning','cashu')), amount bigint NOT NULL CHECK(amount>0), unit text NOT NULL CHECK(unit='sat'),
  state text NOT NULL CHECK(state IN ('pending','verifying','settled','credited','failed','reconciliation_pending')), settlement_reference text UNIQUE NOT NULL, policy_version text,
  accounting_realm text NOT NULL DEFAULT 'production-real' CHECK(accounting_realm='production-real'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS production_real.session_cap_holds (
  hold_id text PRIMARY KEY, account_id text NOT NULL REFERENCES production_real.funding_accounts(account_id), reference text UNIQUE NOT NULL, requested_cap bigint NOT NULL CHECK(requested_cap>0), held_amount bigint NOT NULL CHECK(held_amount>0), state text NOT NULL CHECK(state IN ('active','released','consumed')),
  accounting_realm text NOT NULL DEFAULT 'production-real' CHECK(accounting_realm='production-real'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS production_real.admissions (
  admission_id text PRIMARY KEY, account_id text NOT NULL REFERENCES production_real.funding_accounts(account_id), reference text UNIQUE NOT NULL, capacity_reference text NOT NULL, state text NOT NULL CHECK(state IN ('accepted','refused','reconciliation_pending')),
  accounting_realm text NOT NULL DEFAULT 'production-real' CHECK(accounting_realm='production-real'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS production_real.action_budget_reservations (
  reservation_id text PRIMARY KEY, account_id text NOT NULL REFERENCES production_real.funding_accounts(account_id), admission_reference text NOT NULL REFERENCES production_real.admissions(reference), idempotency_key text NOT NULL, fingerprint_sha256 char(64) NOT NULL, reservation_reference text UNIQUE NOT NULL, amount bigint NOT NULL CHECK(amount>0), unit text NOT NULL CHECK(unit='sat'), state text NOT NULL CHECK(state='authorized'),
  accounting_realm text NOT NULL DEFAULT 'production-real' CHECK(accounting_realm='production-real'), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,idempotency_key)
);

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA production_real TO napplet_production_real;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA production_real TO napplet_production_real;
ALTER DEFAULT PRIVILEGES IN SCHEMA production_real GRANT SELECT, INSERT, UPDATE ON TABLES TO napplet_production_real;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO napplet_development_history;
