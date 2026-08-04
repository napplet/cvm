-- Phase 04: durable receipt-first metered actions. All financial amounts are integer sats.
BEGIN;

CREATE TABLE IF NOT EXISTS model_profile_versions (
  id text PRIMARY KEY, profile_hash text NOT NULL UNIQUE, provider text NOT NULL, model text NOT NULL,
  normalized_profile jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS price_card_versions (
  id text PRIMARY KEY, card_hash text NOT NULL UNIQUE, profile_id text NOT NULL REFERENCES model_profile_versions(id),
  unit text NOT NULL CHECK (unit = 'sat'), normalized_card jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS metered_sessions (
  id text PRIMARY KEY, account_id text NOT NULL REFERENCES funding_accounts(account_id), admission_reference text NOT NULL,
  profile_id text NOT NULL REFERENCES model_profile_versions(id), price_card_id text NOT NULL REFERENCES price_card_versions(id),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0), state text NOT NULL CHECK (state IN ('prepared','active','failed','usage_unknown','billing_invariant_failed','verified')),
  confirmed_spend_sat bigint NOT NULL DEFAULT 0 CHECK (confirmed_spend_sat >= 0), current_verified_artifact_version integer NOT NULL DEFAULT 0 CHECK (current_verified_artifact_version >= 0),
  UNIQUE (account_id, id)
);
CREATE TABLE IF NOT EXISTS metered_actions (
  id text PRIMARY KEY, account_id text NOT NULL REFERENCES funding_accounts(account_id), session_id text NOT NULL REFERENCES metered_sessions(id),
  idempotency_key text NOT NULL, fingerprint text NOT NULL, expected_session_version integer NOT NULL CHECK (expected_session_version >= 0),
  budget_reference text NOT NULL REFERENCES action_budget_reservations(reservation_reference), reservation_sat bigint NOT NULL CHECK (reservation_sat > 0), operation_id text NOT NULL UNIQUE,
  profile_id text NOT NULL REFERENCES model_profile_versions(id), price_card_id text NOT NULL REFERENCES price_card_versions(id),
  state text NOT NULL CHECK (state IN ('prepared','active','failed','usage_unknown','billing_invariant_failed','verified')),
  terminal_result jsonb, evidence_reference text, settled_at timestamptz,
  UNIQUE (account_id, idempotency_key), UNIQUE (account_id, id),
  CHECK ((terminal_result IS NULL AND settled_at IS NULL) OR (terminal_result IS NOT NULL AND settled_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS provider_operations (
  id text PRIMARY KEY, account_id text NOT NULL REFERENCES funding_accounts(account_id), action_id text NOT NULL REFERENCES metered_actions(id),
  provider text NOT NULL, model text NOT NULL, provider_request_id text NOT NULL, sub_reservation_sat bigint NOT NULL CHECK (sub_reservation_sat > 0),
  state text NOT NULL CHECK (state IN ('prepared','active','failed','usage_unknown','billing_invariant_failed','verified')),
  UNIQUE (account_id, id), UNIQUE (provider, model, provider_request_id), UNIQUE (action_id, id)
);
-- The SQL authority projects these finalized action facts directly for replay,
-- owner status, and exact ledger reconciliation. Keep this contract in the
-- migration (including upgrades from the first Phase 04 draft).
ALTER TABLE metered_actions ADD COLUMN IF NOT EXISTS admission_reference text;
ALTER TABLE metered_actions ADD COLUMN IF NOT EXISTS receipt_charge bigint;
ALTER TABLE metered_actions ADD COLUMN IF NOT EXISTS provider_receipt_reference text;
ALTER TABLE metered_actions ADD COLUMN IF NOT EXISTS session_version integer;
ALTER TABLE metered_actions ADD COLUMN IF NOT EXISTS artifact_version integer;
ALTER TABLE metered_actions ADD COLUMN IF NOT EXISTS remaining_cap_sat bigint;
ALTER TABLE metered_actions ADD COLUMN IF NOT EXISTS remaining_balance_sat bigint;
DO $$ BEGIN
  ALTER TABLE metered_actions ADD CONSTRAINT metered_actions_operation_fk FOREIGN KEY (operation_id) REFERENCES provider_operations(id) DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS usage_receipts (
  id text PRIMARY KEY, account_id text NOT NULL REFERENCES funding_accounts(account_id), action_id text NOT NULL REFERENCES metered_actions(id), operation_id text NOT NULL REFERENCES provider_operations(id),
  provider text NOT NULL, model text NOT NULL, provider_receipt_id text NOT NULL, normalized_receipt jsonb NOT NULL, protected_evidence_reference text NOT NULL,
  UNIQUE (operation_id), UNIQUE (provider, model, provider_receipt_id)
);
CREATE TABLE IF NOT EXISTS billing_line_items (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id text NOT NULL UNIQUE, account_id text NOT NULL REFERENCES funding_accounts(account_id),
  session_id text REFERENCES metered_sessions(id), action_id text REFERENCES metered_actions(id), operation_id text REFERENCES provider_operations(id),
  source_identity text NOT NULL UNIQUE, kind text NOT NULL CHECK (kind IN ('credit','cap_hold','action_reservation','receipt','debit','release','reconciliation')),
  unit text NOT NULL CHECK (unit = 'sat'), amount_sat bigint NOT NULL, settled_available_sat bigint NOT NULL CHECK (settled_available_sat >= 0),
  held_sat bigint NOT NULL CHECK (held_sat >= 0), session_spend_sat bigint NOT NULL CHECK (session_spend_sat >= 0), committed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS session_artifacts (
  id text PRIMARY KEY, account_id text NOT NULL REFERENCES funding_accounts(account_id), session_id text NOT NULL REFERENCES metered_sessions(id), action_id text NOT NULL UNIQUE REFERENCES metered_actions(id),
  version integer NOT NULL CHECK (version > 0), lineage jsonb NOT NULL, validation_evidence_reference text NOT NULL, verified boolean NOT NULL,
  UNIQUE (session_id, version)
);
CREATE TABLE IF NOT EXISTS provider_reconciliations (
  id text PRIMARY KEY, account_id text NOT NULL REFERENCES funding_accounts(account_id), action_id text NOT NULL UNIQUE REFERENCES metered_actions(id), operation_id text NOT NULL UNIQUE REFERENCES provider_operations(id),
  reason text NOT NULL, receipt_reference text, state text NOT NULL CHECK (state IN ('open','resolved')) DEFAULT 'open', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS profile_quarantines (
  id text PRIMARY KEY, profile_id text NOT NULL REFERENCES model_profile_versions(id), price_card_id text NOT NULL REFERENCES price_card_versions(id),
  action_id text NOT NULL UNIQUE REFERENCES metered_actions(id), reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (profile_id, price_card_id)
);

-- Existing Phase 3 credits and holds are projected exactly once into the append-only history.
INSERT INTO billing_line_items (id, account_id, source_identity, kind, unit, amount_sat, settled_available_sat, held_sat, session_spend_sat)
SELECT 'backfill:credit:' || le.entry_id, le.account_id, 'phase3-credit:' || le.entry_id, 'credit', 'sat', le.amount, abp.settled_available, abp.held, 0
FROM ledger_entries le JOIN account_balance_projection abp ON abp.account_id = le.account_id
WHERE le.direction = 'credit' AND le.account_id <> 'treasury:clearing' ON CONFLICT (source_identity) DO NOTHING;

CREATE OR REPLACE FUNCTION reject_phase04_append_only_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'PHASE04_APPEND_ONLY'; END; $$;
CREATE TRIGGER billing_line_items_append_only BEFORE UPDATE OR DELETE ON billing_line_items FOR EACH ROW EXECUTE FUNCTION reject_phase04_append_only_change();
CREATE TRIGGER usage_receipts_append_only BEFORE UPDATE OR DELETE ON usage_receipts FOR EACH ROW EXECUTE FUNCTION reject_phase04_append_only_change();
COMMIT;
