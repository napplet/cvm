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
CREATE TABLE IF NOT EXISTS production_real.settlement_attempts (attempt_id text PRIMARY KEY, top_up_id text NOT NULL REFERENCES production_real.top_ups(top_up_id), external_reference text UNIQUE NOT NULL, proof_commitment char(64) UNIQUE, observed_state text NOT NULL, accounting_realm text NOT NULL DEFAULT 'production-real' CHECK(accounting_realm='production-real'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS production_real.capacity_intents (intent_id text PRIMARY KEY, account_id text NOT NULL REFERENCES production_real.funding_accounts(account_id), idempotency_key text NOT NULL, fingerprint_sha256 char(64) NOT NULL, intent_reference text UNIQUE NOT NULL, capacity_reference text, expires_at timestamptz, state text NOT NULL CHECK(state IN ('created','dispatching','available','refused','reconciliation_pending','released')), accounting_realm text NOT NULL DEFAULT 'production-real' CHECK(accounting_realm='production-real'), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,idempotency_key));
CREATE TABLE IF NOT EXISTS production_real.treasury_reconciliation (reconciliation_id text PRIMARY KEY, top_up_id text UNIQUE NOT NULL REFERENCES production_real.top_ups(top_up_id), state text NOT NULL, accounting_realm text NOT NULL DEFAULT 'production-real' CHECK(accounting_realm='production-real'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS production_real.protected_rail_material (material_id text PRIMARY KEY, account_id text NOT NULL REFERENCES production_real.funding_accounts(account_id), top_up_id text NOT NULL REFERENCES production_real.top_ups(top_up_id), rail text NOT NULL CHECK(rail IN ('lightning','cashu')), payload_digest char(64) NOT NULL, nonce bytea NOT NULL, ciphertext bytea NOT NULL, key_reference text NOT NULL DEFAULT 'legacy-envelope', expires_at timestamptz, expired_at timestamptz, accounting_realm text NOT NULL DEFAULT 'production-real' CHECK(accounting_realm='production-real'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS production_real.cashu_policy_versions (policy_version text PRIMARY KEY, immutable_hash char(64) UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS production_real.cashu_mints (policy_version text NOT NULL REFERENCES production_real.cashu_policy_versions(policy_version), mint_url text NOT NULL, keyset_id text NOT NULL, unit text NOT NULL CHECK(unit='sat'), PRIMARY KEY(policy_version,mint_url,keyset_id));
CREATE TABLE IF NOT EXISTS production_real.lightning_top_up_state (state_key text PRIMARY KEY, state_json jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS production_real.cashu_top_up_state (top_up_id text PRIMARY KEY, account_id text NOT NULL REFERENCES production_real.funding_accounts(account_id), proof_commitment char(64) UNIQUE NOT NULL, state_json jsonb NOT NULL, treasury_json jsonb, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS production_real.funding_outbox (outbox_id text PRIMARY KEY, aggregate_reference text NOT NULL, event_kind text NOT NULL, payload_json jsonb NOT NULL, state text NOT NULL DEFAULT 'pending', UNIQUE(aggregate_reference,event_kind));

-- When upgrading an already-migrated authority, clone every compatible Phase
-- 04–06 table plus its indexes, checks and foreign keys into this fresh realm.
-- A clean installation applies those migrations later through production_real.
DO $$ DECLARE t text; c record; BEGIN
  PERFORM set_config('search_path','production_real,pg_catalog',true);
  FOREACH t IN ARRAY ARRAY['model_profile_versions','price_card_versions','metered_sessions','metered_actions','provider_operations','usage_receipts','billing_line_items','session_artifacts','provider_reconciliations','profile_quarantines','continuation_pauses','continuation_wake_dispatches','continuation_checkpoints','continuation_resume_commands','continuation_restore_observations','continuation_tombstones','continuation_deletions','publication_commands','publication_intents','publication_effect_intents','publication_signed_events','publication_records'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL AND to_regclass('production_real.' || t) IS NULL THEN
      EXECUTE format('CREATE TABLE production_real.%I (LIKE public.%I INCLUDING ALL)', t, t);
      FOR c IN SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=('public.' || t)::regclass AND contype='f' LOOP
        EXECUTE format('ALTER TABLE production_real.%I ADD CONSTRAINT %I %s', t, c.conname, c.definition);
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- The durable recovery authority stores ciphertext and broker references only.
-- It never stores a raw Cashu proof, NWC URI, invoice, or preimage.
CREATE TABLE IF NOT EXISTS production_real.rail_custody_material (
  custody_id text PRIMARY KEY, operation_id text NOT NULL, account_id text NOT NULL REFERENCES production_real.funding_accounts(account_id), rail text NOT NULL CHECK(rail IN ('cashu','lightning')),
  material_kind text NOT NULL CHECK(material_kind IN ('cashu_input','cashu_blinded_message','cashu_output','lightning_intent')), key_reference text NOT NULL CHECK(length(key_reference)>0), payload_digest char(64) NOT NULL,
  canonical_proof_identity char(64), mint_url text, keyset_id text, unit text CHECK(unit='sat'), nonce bytea NOT NULL CHECK(octet_length(nonce)=12), ciphertext bytea NOT NULL CHECK(octet_length(ciphertext)>0),
  accounting_realm text NOT NULL DEFAULT 'production-real' CHECK(accounting_realm='production-real'), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(operation_id,material_kind,payload_digest)
);
CREATE TABLE IF NOT EXISTS production_real.uncertain_rail_operations (
  operation_id text PRIMARY KEY, account_id text NOT NULL REFERENCES production_real.funding_accounts(account_id), rail text NOT NULL CHECK(rail IN ('cashu','lightning')),
  provider_locator text NOT NULL, stable_label text, state text NOT NULL CHECK(state IN ('created','dispatching','unknown','observed_pending','observed_succeeded','observed_failed')),
  accounting_realm text NOT NULL DEFAULT 'production-real' CHECK(accounting_realm='production-real'), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(rail,provider_locator), UNIQUE(account_id,rail,stable_label)
);
ALTER TABLE production_real.uncertain_rail_operations ADD CONSTRAINT uncertain_rail_operation_identity UNIQUE(operation_id,account_id,rail);
ALTER TABLE production_real.rail_custody_material ADD CONSTRAINT rail_custody_operation_fk FOREIGN KEY(operation_id,account_id,rail) REFERENCES production_real.uncertain_rail_operations(operation_id,account_id,rail);
CREATE UNIQUE INDEX IF NOT EXISTS rail_custody_semantic_proof_identity ON production_real.rail_custody_material(mint_url,keyset_id,unit,canonical_proof_identity) WHERE canonical_proof_identity IS NOT NULL;
CREATE TABLE IF NOT EXISTS production_real.uncertain_rail_operation_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, operation_id text NOT NULL REFERENCES production_real.uncertain_rail_operations(operation_id), prior_state text, next_state text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(), UNIQUE(operation_id,prior_state,next_state,observed_at)
);
CREATE OR REPLACE FUNCTION production_real.enforce_uncertain_rail_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.operation_id<>NEW.operation_id OR OLD.account_id<>NEW.account_id OR OLD.rail<>NEW.rail OR OLD.provider_locator<>NEW.provider_locator OR OLD.stable_label IS DISTINCT FROM NEW.stable_label OR OLD.accounting_realm<>NEW.accounting_realm THEN RAISE EXCEPTION 'PRODUCTION_OPERATION_IDENTITY_IMMUTABLE'; END IF;
    IF OLD.state<>NEW.state AND NOT ((OLD.state='created' AND NEW.state IN ('dispatching','unknown','observed_pending','observed_failed')) OR (OLD.state='dispatching' AND NEW.state IN ('unknown','observed_pending','observed_succeeded','observed_failed')) OR (OLD.state IN ('unknown','observed_pending') AND NEW.state IN ('unknown','observed_pending','observed_succeeded','observed_failed'))) THEN RAISE EXCEPTION 'PRODUCTION_OPERATION_STATE_TRANSITION_INVALID'; END IF;
    IF OLD.state<>NEW.state THEN INSERT INTO production_real.uncertain_rail_operation_audit(operation_id,prior_state,next_state) VALUES(NEW.operation_id,OLD.state,NEW.state); END IF;
  ELSIF TG_OP='INSERT' THEN
    IF NEW.state <> 'created' THEN RAISE EXCEPTION 'PRODUCTION_OPERATION_INITIAL_STATE_INVALID'; END IF;
    INSERT INTO production_real.uncertain_rail_operation_audit(operation_id,prior_state,next_state) VALUES(NEW.operation_id,NULL,NEW.state);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS uncertain_rail_operation_immutable ON production_real.uncertain_rail_operations;
CREATE TRIGGER uncertain_rail_operation_immutable AFTER INSERT OR UPDATE ON production_real.uncertain_rail_operations FOR EACH ROW EXECUTE FUNCTION production_real.enforce_uncertain_rail_operation();
CREATE OR REPLACE FUNCTION production_real.reject_custody_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRODUCTION_CUSTODY_IMMUTABLE'; END $$;
DROP TRIGGER IF EXISTS rail_custody_immutable ON production_real.rail_custody_material;
CREATE TRIGGER rail_custody_immutable BEFORE UPDATE OR DELETE ON production_real.rail_custody_material FOR EACH ROW EXECUTE FUNCTION production_real.reject_custody_mutation();

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA production_real TO napplet_production_real;
REVOKE UPDATE, DELETE, TRUNCATE ON production_real.ledger_entries, production_real.ledger_transactions, production_real.uncertain_rail_operation_audit, production_real.rail_custody_material FROM napplet_production_real;
REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA production_real FROM napplet_production_real;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA production_real TO napplet_production_real;
ALTER DEFAULT PRIVILEGES IN SCHEMA production_real GRANT SELECT, INSERT, UPDATE ON TABLES TO napplet_production_real;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO napplet_development_history;
