BEGIN;
-- One completed priced claim owns one immutable terminal-cleanup proof.  This
-- is deliberately SQL-scoped instead of journal-scoped so every mounted
-- facade can make the same no-provider replay decision.
CREATE TABLE IF NOT EXISTS production_real.priced_continuation_cleanup_proofs (
  claim_reference text PRIMARY KEY,
  account_id text NOT NULL,
  proof_revision integer NOT NULL DEFAULT 1 CHECK(proof_revision=1),
  proof_sha256 text NOT NULL CHECK(proof_sha256 ~ '^[a-f0-9]{64}$'),
  proof_json jsonb NOT NULL CHECK(jsonb_typeof(proof_json)='object' AND octet_length(proof_json::text)<=16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(claim_reference,account_id) REFERENCES production_real.priced_continuation_claims(claim_reference,account_id)
);
CREATE OR REPLACE FUNCTION production_real.guard_priced_cleanup_proof() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PRICED_CLEANUP_PROOF_IMMUTABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM production_real.priced_continuation_claims c
    JOIN production_real.priced_continuation_worker_intents w ON w.claim_reference=c.claim_reference AND w.account_id=c.account_id
    JOIN production_real.priced_continuation_worker_allocations a ON a.claim_reference=c.claim_reference AND a.account_id=c.account_id
    JOIN production_real.priced_continuation_finalizations f ON f.claim_reference=c.claim_reference AND f.account_id=c.account_id
    JOIN production_real.continuation_checkpoints cp ON cp.checkpoint_id=c.checkpoint_id AND cp.account_id=c.account_id AND cp.session_id=c.session_id
    JOIN production_real.continuation_pauses p ON p.account_id=cp.account_id AND p.session_id=cp.session_id AND p.pause_generation=cp.pause_generation
    WHERE c.claim_reference=NEW.claim_reference AND c.account_id=NEW.account_id AND c.state='completed'
      AND p.state='completed' AND p.live_lease_token IS NULL
      AND NEW.proof_json->>'version'='2' AND NEW.proof_json->>'claimReference'=c.claim_reference AND NEW.proof_json->>'accountId'=c.account_id
      AND NEW.proof_json->>'sessionId'=c.session_id AND NEW.proof_json->>'checkpointId'=c.checkpoint_id AND NEW.proof_json->>'actionId'=c.action_id
      AND NEW.proof_json->>'operationId'=c.operation_id AND NEW.proof_json->>'leaseToken'=c.lease_token
      AND NEW.proof_json->>'allocationIntentReference'=c.allocation_intent_reference
      AND NEW.proof_json->>'capacityIntentReference'=w.capacity_intent_reference AND NEW.proof_json->>'capacityReference'=a.capacity_reference
      AND NEW.proof_json->>'sessionBindingDigest'=w.session_binding_digest
      AND (NEW.proof_json->>'expectedSessionVersion')::integer=cp.expected_session_version
      AND (NEW.proof_json->>'expectedArtifactVersion')::integer=cp.expected_artifact_version
      AND (NEW.proof_json->>'pauseGeneration')::integer=cp.pause_generation)
  THEN RAISE EXCEPTION 'PRICED_CLEANUP_PROOF_BINDING_DENIED'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS priced_cleanup_proof_guard ON production_real.priced_continuation_cleanup_proofs;
CREATE TRIGGER priced_cleanup_proof_guard BEFORE INSERT OR UPDATE OR DELETE ON production_real.priced_continuation_cleanup_proofs
  FOR EACH ROW EXECUTE FUNCTION production_real.guard_priced_cleanup_proof();
REVOKE ALL ON production_real.priced_continuation_cleanup_proofs FROM PUBLIC,napplet_production_real;
GRANT SELECT,INSERT ON production_real.priced_continuation_cleanup_proofs TO napplet_production_real;
COMMIT;
