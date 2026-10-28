BEGIN;
-- Expand without losing the original requested maximum. The initial accepted
-- command is the authority for the funded maximum, including partial funding.
ALTER TABLE production_real.session_cap_holds ADD COLUMN IF NOT EXISTS approved_cap bigint;
UPDATE production_real.session_cap_holds h SET approved_cap=(
  SELECT (c.result_json->>'approvedCap')::bigint FROM production_real.funding_commands c
  WHERE c.account_id=h.account_id AND c.result_json->>'status'='accepted' AND c.result_json->>'reference'=h.reference
) WHERE approved_cap IS NULL;
ALTER TABLE production_real.session_cap_holds ALTER COLUMN approved_cap SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='production_real.session_cap_holds'::regclass AND conname='session_cap_approved_positive') THEN
    ALTER TABLE production_real.session_cap_holds ADD CONSTRAINT session_cap_approved_positive CHECK(approved_cap>0 AND approved_cap<=requested_cap AND approved_cap>=held_amount);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS session_cap_admission_owner ON production_real.admissions(account_id,reference);
CREATE UNIQUE INDEX IF NOT EXISTS session_cap_session_binding ON production_real.metered_sessions(id,account_id,admission_reference);
CREATE TABLE IF NOT EXISTS production_real.session_cap_approvals (
  approval_reference text PRIMARY KEY,
  account_id text NOT NULL REFERENCES production_real.funding_accounts(account_id),
  session_id text NOT NULL,
  admission_reference text NOT NULL REFERENCES production_real.admissions(reference),
  idempotency_key text NOT NULL,
  fingerprint_sha256 text NOT NULL CHECK(fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  consent_reference text NOT NULL CHECK(consent_reference ~ '^nostr:[a-f0-9]{64}$'),
  policy_version text NOT NULL, protocol_version text NOT NULL,
  previous_requested_cap bigint NOT NULL,
  requested_cap bigint NOT NULL,
  previous_approved_cap bigint NOT NULL CHECK(previous_approved_cap>0),
  approved_cap bigint NOT NULL CHECK(approved_cap>previous_approved_cap),
  previous_held_amount bigint NOT NULL CHECK(previous_held_amount>=0),
  held_amount bigint NOT NULL,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(account_id,idempotency_key), UNIQUE(account_id,admission_reference,approved_cap),
  FOREIGN KEY(session_id,account_id,admission_reference) REFERENCES production_real.metered_sessions(id,account_id,admission_reference),
  FOREIGN KEY(account_id,admission_reference) REFERENCES production_real.admissions(account_id,reference),
  CHECK(held_amount=previous_held_amount+approved_cap-previous_approved_cap),
  CHECK(previous_held_amount<=previous_approved_cap AND held_amount<=approved_cap),
  CHECK(previous_requested_cap>=previous_approved_cap AND requested_cap=GREATEST(previous_requested_cap,approved_cap)),
  CHECK((result_json->>'status'='approved' AND result_json->>'approvalReference'=approval_reference AND result_json->>'accountId'=account_id AND result_json->>'sessionId'=session_id AND result_json->>'admissionReference'=admission_reference AND (result_json->>'previousApprovedCap')::bigint=previous_approved_cap AND (result_json->>'approvedCap')::bigint=approved_cap AND (result_json->>'heldAmount')::bigint=held_amount AND result_json->>'unit'='sat') IS TRUE)
);
CREATE OR REPLACE FUNCTION production_real.guard_session_cap_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.approved_cap IS NOT NULL AND NEW.approved_cap<>NEW.held_amount THEN RAISE EXCEPTION 'INITIAL_SESSION_CAP_MISMATCH'; END IF;
    NEW.approved_cap=NEW.held_amount;
    RETURN NEW;
  END IF;
  IF NEW.approved_cap IS NOT DISTINCT FROM OLD.approved_cap THEN RETURN NEW; END IF;
  IF NEW.approved_cap<=OLD.approved_cap OR NEW.held_amount-OLD.held_amount<>NEW.approved_cap-OLD.approved_cap OR NOT EXISTS(
    SELECT 1 FROM production_real.session_cap_approvals a WHERE a.account_id=OLD.account_id AND a.admission_reference=OLD.reference AND a.previous_approved_cap=OLD.approved_cap AND a.approved_cap=NEW.approved_cap AND a.previous_held_amount=OLD.held_amount AND a.held_amount=NEW.held_amount AND a.previous_requested_cap=OLD.requested_cap AND a.requested_cap=NEW.requested_cap
  ) THEN RAISE EXCEPTION 'SESSION_CAP_APPROVAL_REQUIRED'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS initial_session_cap ON production_real.session_cap_holds;
CREATE TRIGGER initial_session_cap BEFORE INSERT ON production_real.session_cap_holds FOR EACH ROW EXECUTE FUNCTION production_real.guard_session_cap_approval();
DROP TRIGGER IF EXISTS session_cap_approval ON production_real.session_cap_holds;
CREATE TRIGGER session_cap_approval BEFORE UPDATE OF approved_cap ON production_real.session_cap_holds FOR EACH ROW EXECUTE FUNCTION production_real.guard_session_cap_approval();
CREATE OR REPLACE FUNCTION production_real.guard_session_cap_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'SESSION_CAP_APPROVAL_IMMUTABLE'; END $$;
DROP TRIGGER IF EXISTS session_cap_history_immutable ON production_real.session_cap_approvals;
CREATE TRIGGER session_cap_history_immutable BEFORE UPDATE OR DELETE ON production_real.session_cap_approvals FOR EACH ROW EXECUTE FUNCTION production_real.guard_session_cap_history();
REVOKE ALL ON production_real.session_cap_approvals FROM PUBLIC,napplet_production_real;
GRANT SELECT,INSERT ON production_real.session_cap_approvals TO napplet_production_real;
COMMIT;
