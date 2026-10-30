BEGIN;
-- Expand only. V1 allocation rows and their legacy resume-command FKs stay
-- authoritative for v1. These rows describe one explicit v2 resume, no queue.
CREATE UNIQUE INDEX IF NOT EXISTS priced_continuation_worker_owner ON production_real.priced_continuation_claims(claim_reference,account_id,session_id,action_id,allocation_intent_reference);
CREATE UNIQUE INDEX IF NOT EXISTS priced_capacity_intent_owner ON production_real.capacity_intents(account_id,intent_reference);
CREATE TABLE IF NOT EXISTS production_real.priced_continuation_worker_intents (
  claim_reference text PRIMARY KEY, account_id text NOT NULL, session_id text NOT NULL, action_id text NOT NULL UNIQUE,
  allocation_intent_reference text NOT NULL UNIQUE, capacity_intent_reference text NOT NULL UNIQUE,
  fingerprint_sha256 text NOT NULL CHECK(fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  session_binding_digest text NOT NULL CHECK(session_binding_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(claim_reference,account_id,session_id,action_id,allocation_intent_reference)
    REFERENCES production_real.priced_continuation_claims(claim_reference,account_id,session_id,action_id,allocation_intent_reference),
  FOREIGN KEY(account_id,capacity_intent_reference) REFERENCES production_real.capacity_intents(account_id,intent_reference),
  UNIQUE(claim_reference,account_id,capacity_intent_reference)
);
CREATE TABLE IF NOT EXISTS production_real.priced_continuation_worker_allocations (
  claim_reference text PRIMARY KEY, account_id text NOT NULL, capacity_intent_reference text NOT NULL UNIQUE,
  capacity_reference text NOT NULL UNIQUE,
  ready_proof_json jsonb NOT NULL CHECK(jsonb_typeof(ready_proof_json)='object' AND octet_length(ready_proof_json::text)<=4096),
  expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(claim_reference,account_id,capacity_intent_reference)
    REFERENCES production_real.priced_continuation_worker_intents(claim_reference,account_id,capacity_intent_reference),
  FOREIGN KEY(account_id,capacity_intent_reference,capacity_reference)
    REFERENCES production_real.capacity_intents(account_id,intent_reference,capacity_reference),
  CHECK((ready_proof_json->>'intentReference'=capacity_intent_reference AND ready_proof_json->>'leaseReference'=capacity_reference
    AND ready_proof_json->>'sessionBindingDigest' ~ '^sha256:[a-f0-9]{64}$'
    AND ready_proof_json->>'imageDigest' ~ '^sha256:[a-f0-9]{64}$'
    AND ready_proof_json->>'readinessProbeDigest' ~ '^sha256:[a-f0-9]{64}$'
    AND jsonb_typeof(ready_proof_json->'readyMonotonicMs')='number'
    AND (ready_proof_json->>'readyMonotonicMs')::numeric BETWEEN 0 AND 9007199254740991) IS TRUE)
);
CREATE OR REPLACE FUNCTION production_real.guard_priced_worker_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PRICED_WORKER_RECORD_IMMUTABLE'; END IF;
  IF TG_TABLE_NAME='priced_continuation_worker_intents' THEN
    IF NOT EXISTS(SELECT 1 FROM production_real.priced_continuation_claims c
      JOIN production_real.capacity_intents i ON i.account_id=c.account_id AND i.intent_reference=NEW.capacity_intent_reference
      JOIN production_real.resume_pricing_quotes q ON q.quote_reference=c.quote_reference
      WHERE c.claim_reference=NEW.claim_reference AND c.state IN ('accepted','dispatching') AND c.worker_claimed_at_ms IS NOT NULL
        AND i.state='created' AND i.idempotency_key=c.allocation_intent_reference AND i.fingerprint_sha256=NEW.fingerprint_sha256
        AND q.expires_at_ms>extract(epoch FROM clock_timestamp())*1000)
    THEN RAISE EXCEPTION 'PRICED_WORKER_INTENT_BINDING_DENIED'; END IF;
  ELSIF TG_TABLE_NAME='priced_continuation_worker_allocations' THEN
    IF NOT EXISTS(SELECT 1 FROM production_real.priced_continuation_worker_intents w
      JOIN production_real.priced_continuation_claims c ON c.claim_reference=w.claim_reference
      JOIN production_real.capacity_intents i ON i.account_id=w.account_id AND i.intent_reference=w.capacity_intent_reference
      WHERE w.claim_reference=NEW.claim_reference AND w.account_id=NEW.account_id AND w.capacity_intent_reference=NEW.capacity_intent_reference
        AND c.state IN ('accepted','dispatching') AND c.worker_claimed_at_ms IS NOT NULL AND i.state='available'
        AND i.capacity_reference=NEW.capacity_reference AND i.expires_at=NEW.expires_at
        AND NEW.ready_proof_json->>'sessionBindingDigest'=w.session_binding_digest
        AND NEW.expires_at>clock_timestamp())
    THEN RAISE EXCEPTION 'PRICED_WORKER_ALLOCATION_BINDING_DENIED'; END IF;
  ELSE RAISE EXCEPTION 'PRICED_WORKER_RECORD_INVALID'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS priced_worker_intent_guard ON production_real.priced_continuation_worker_intents;
CREATE TRIGGER priced_worker_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON production_real.priced_continuation_worker_intents
  FOR EACH ROW EXECUTE FUNCTION production_real.guard_priced_worker_record();
DROP TRIGGER IF EXISTS priced_worker_allocation_guard ON production_real.priced_continuation_worker_allocations;
CREATE TRIGGER priced_worker_allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON production_real.priced_continuation_worker_allocations
  FOR EACH ROW EXECUTE FUNCTION production_real.guard_priced_worker_record();
CREATE OR REPLACE FUNCTION production_real.fence_priced_capacity_dispatch() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE claim production_real.priced_continuation_claims%ROWTYPE;
BEGIN
  SELECT c.* INTO claim FROM production_real.priced_continuation_claims c
    JOIN production_real.priced_continuation_worker_intents w ON w.claim_reference=c.claim_reference
    WHERE w.account_id=OLD.account_id AND w.capacity_intent_reference=OLD.intent_reference FOR UPDATE OF c;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','capacity_reference','expires_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','capacity_reference','expires_at'])
    OR (OLD.capacity_reference IS NOT NULL AND NEW.capacity_reference IS DISTINCT FROM OLD.capacity_reference)
    OR (OLD.expires_at IS NOT NULL AND NEW.expires_at IS DISTINCT FROM OLD.expires_at)
    OR NOT(NEW.state=OLD.state OR
      (OLD.state='created' AND NEW.state IN ('dispatching','released')) OR
      (OLD.state='dispatching' AND NEW.state IN ('available','refused','reconciliation_pending','released')) OR
      (OLD.state='reconciliation_pending' AND NEW.state IN ('available','refused','released')) OR
      (OLD.state='available' AND NEW.state IN ('reconciliation_pending','refused','released')) OR
      (OLD.state='refused' AND NEW.state='released'))
    OR (NEW.state IN ('dispatching','available') AND claim.state NOT IN ('accepted','dispatching'))
  THEN RAISE EXCEPTION 'PRICED_CAPACITY_TRANSITION_DENIED'; END IF;
  IF NEW.state<>'dispatching' OR OLD.state='dispatching' THEN RETURN NEW; END IF;
  IF OLD.state<>'created' OR claim.state NOT IN ('accepted','dispatching') OR claim.worker_claimed_at_ms IS NULL OR NOT EXISTS(
    SELECT 1 FROM production_real.resume_pricing_quotes q
    JOIN production_real.continuation_checkpoints cp ON cp.checkpoint_id=claim.checkpoint_id AND cp.account_id=claim.account_id
    JOIN production_real.continuation_pauses p ON p.account_id=cp.account_id AND p.session_id=cp.session_id AND p.pause_generation=cp.pause_generation
    JOIN production_real.action_budget_reservations b ON b.reservation_reference=claim.action_budget_reference AND b.account_id=claim.account_id
    JOIN production_real.metered_actions a ON a.id=claim.action_id AND a.account_id=claim.account_id
    JOIN production_real.session_cap_holds h ON h.reference=a.admission_reference AND h.account_id=claim.account_id AND h.state='active'
    WHERE q.quote_reference=claim.quote_reference AND q.prepared_at_ms<=extract(epoch FROM clock_timestamp())*1000
      AND q.expires_at_ms>extract(epoch FROM clock_timestamp())*1000 AND cp.state='claimed' AND p.state='claimed'
      AND cp.retention_deadline_ms>extract(epoch FROM clock_timestamp())*1000 AND b.state='authorized' AND b.amount<=h.held_amount
      AND a.state IN ('prepared','active') AND a.terminal_result IS NULL)
  THEN RAISE EXCEPTION 'PRICED_CAPACITY_DISPATCH_DENIED'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS priced_capacity_dispatch_fence ON production_real.capacity_intents;
CREATE TRIGGER priced_capacity_dispatch_fence BEFORE UPDATE ON production_real.capacity_intents
  FOR EACH ROW EXECUTE FUNCTION production_real.fence_priced_capacity_dispatch();
REVOKE ALL ON production_real.priced_continuation_worker_intents,production_real.priced_continuation_worker_allocations FROM PUBLIC,napplet_production_real;
GRANT SELECT,INSERT ON production_real.priced_continuation_worker_intents,production_real.priced_continuation_worker_allocations TO napplet_production_real;
COMMIT;
