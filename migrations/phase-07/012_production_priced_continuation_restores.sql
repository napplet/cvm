BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS priced_restore_owner ON production_real.priced_continuation_claims(claim_reference,account_id);
CREATE TABLE IF NOT EXISTS production_real.priced_continuation_restores (
  claim_reference text PRIMARY KEY, account_id text NOT NULL,
  restore_operation_id text NOT NULL UNIQUE, metadata_sha256 text NOT NULL CHECK(metadata_sha256 ~ '^[a-f0-9]{64}$'),
  metadata_json jsonb NOT NULL CHECK(jsonb_typeof(metadata_json)='object' AND octet_length(metadata_json::text)<=16384),
  manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  command_sha256 text NOT NULL CHECK(command_sha256 ~ '^[a-f0-9]{64}$'),
  payload_kind text NOT NULL CHECK(payload_kind IN ('pending_command','workspace')),
  state text NOT NULL CHECK(state IN ('claimed','unknown','restored')),
  proof_json jsonb CHECK(proof_json IS NULL OR (jsonb_typeof(proof_json)='object' AND octet_length(proof_json::text)<=4096)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(claim_reference,account_id) REFERENCES production_real.priced_continuation_claims(claim_reference,account_id),
  FOREIGN KEY(claim_reference) REFERENCES production_real.priced_continuation_worker_allocations(claim_reference),
  CHECK((state='restored')=(proof_json IS NOT NULL)),
  CHECK(restore_operation_id='priced-restore:'||metadata_sha256)
);
CREATE TABLE IF NOT EXISTS production_real.priced_continuation_restore_audit (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_reference text NOT NULL REFERENCES production_real.priced_continuation_restores(claim_reference),
  state text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION production_real.guard_priced_restore() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PRICED_RESTORE_IMMUTABLE'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(OLD)-ARRAY['state','proof_json','updated_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','proof_json','updated_at'])
      OR (OLD.state='restored' AND ROW(NEW.state,NEW.proof_json) IS DISTINCT FROM ROW(OLD.state,OLD.proof_json))
    THEN RAISE EXCEPTION 'PRICED_RESTORE_IMMUTABLE'; END IF;
    IF NEW.state='claimed' AND OLD.state<>'claimed' THEN RAISE EXCEPTION 'PRICED_RESTORE_REDISPATCH_DENIED'; END IF;
  ELSE
    IF NEW.state<>'claimed' OR NEW.proof_json IS NOT NULL THEN RAISE EXCEPTION 'PRICED_RESTORE_INITIAL_STATE_DENIED'; END IF;
    IF NOT EXISTS(SELECT 1 FROM production_real.priced_continuation_claims c
      JOIN production_real.resume_pricing_quotes q ON q.quote_reference=c.quote_reference
      JOIN production_real.continuation_checkpoints cp ON cp.checkpoint_id=c.checkpoint_id AND cp.account_id=c.account_id
      JOIN production_real.continuation_pauses p ON p.account_id=cp.account_id AND p.session_id=cp.session_id AND p.pause_generation=cp.pause_generation
      JOIN production_real.checkpoint_envelopes e ON e.checkpoint_id=cp.checkpoint_id AND e.account_id=c.account_id
      JOIN production_real.priced_continuation_worker_allocations w ON w.claim_reference=c.claim_reference AND w.account_id=c.account_id
      WHERE c.claim_reference=NEW.claim_reference AND c.account_id=NEW.account_id AND c.state IN ('accepted','dispatching')
        AND c.worker_claimed_at_ms IS NOT NULL AND c.api_claimed_at_ms IS NULL
        AND q.expires_at_ms>extract(epoch FROM clock_timestamp())*1000 AND cp.state='claimed' AND p.state='claimed'
        AND e.state='retained' AND e.retention_until>clock_timestamp() AND w.expires_at>clock_timestamp()
        AND NEW.manifest_sha256=q.quote_json->'context'->>'checkpointSha256' AND NEW.command_sha256=q.quote_json->'context'->>'commandSha256'
        AND cp.manifest_reference='checkpoint-manifest:'||cp.checkpoint_id||':'||NEW.manifest_sha256
        AND NEW.payload_kind=COALESCE(e.manifest_json->>'payloadKind','workspace')
        AND (NEW.metadata_json->>'accountId'=c.account_id AND NEW.metadata_json->>'sessionId'=c.session_id
          AND NEW.metadata_json->>'actionId'=c.action_id AND NEW.metadata_json->>'checkpointId'=c.checkpoint_id
          AND NEW.metadata_json->>'leaseToken'=c.lease_token AND NEW.metadata_json->>'resumeClaim'=c.allocation_intent_reference
          AND (NEW.metadata_json->>'expectedVersion')::integer=cp.expected_session_version
          AND (NEW.metadata_json->>'pauseGeneration')::integer=cp.pause_generation
          AND (NEW.metadata_json->>'actionVersion')::integer=(e.manifest_json->>'actionVersion')::integer
          AND NEW.metadata_json->>'policyVersion'=q.quote_json->'context'->>'policyVersion'
          AND NEW.metadata_json->>'workspaceLineage'=e.manifest_json->>'workspaceLineage'
          AND NEW.metadata_json->>'archiveSha256'=e.manifest_json->>'archiveSha256'
          AND NEW.metadata_json->>'capabilityGrant'='phase-05-continuation-grant') IS TRUE)
    THEN RAISE EXCEPTION 'PRICED_RESTORE_BINDING_DENIED'; END IF;
  END IF;
  IF NEW.state='restored' AND OLD.state<>'restored' THEN
    IF NEW.payload_kind='pending_command' THEN
      IF (NEW.proof_json->>'kind'='command' AND NEW.proof_json->>'commandSha256'=NEW.command_sha256) IS NOT TRUE
      THEN RAISE EXCEPTION 'PRICED_RESTORE_COMMAND_PROOF_DENIED'; END IF;
    ELSE
      IF NOT EXISTS(SELECT 1 FROM production_real.release_operation_journal e
        JOIN production_real.release_operation_journal o ON o.namespace=e.namespace AND o.scope_sha256=e.scope_sha256
          AND o.operation_id=e.value_json->>'originalOperationId' AND o.identity_sha256=e.value_json->>'originalIdentitySha256'
        JOIN production_real.priced_continuation_worker_intents wi ON wi.claim_reference=NEW.claim_reference
        JOIN production_real.priced_continuation_worker_allocations wa ON wa.claim_reference=NEW.claim_reference
        JOIN production_real.release_operation_journal cap ON cap.value_json->>'intentReference'=wi.capacity_intent_reference
          AND cap.value_json->>'reference'=wa.capacity_reference AND cap.value_json->>'workerOperationId'=o.value_json->>'workerOperationId'
        WHERE NEW.proof_json->>'kind'='workspace' AND e.operation_id='worker-restore-evidence:'||NEW.restore_operation_id
          AND e.identity_sha256=NEW.proof_json->>'nativeEvidenceSha256' AND e.revision=1
          AND e.value_json->>'schemaVersion'='worker-restore-evidence-v1'
          AND o.operation_id='worker-restore:'||NEW.restore_operation_id AND o.revision=1
          AND o.value_json->>'bindingSha256'=NEW.metadata_sha256 AND o.value_json->>'archiveSha256'=NEW.metadata_json->>'archiveSha256'
          AND o.value_json->>'leaseSha256'=substring(wi.session_binding_digest FROM 8)
          AND e.value_json->'expected'->>'archiveSha256'=NEW.metadata_json->>'archiveSha256')
      THEN RAISE EXCEPTION 'PRICED_RESTORE_NATIVE_PROOF_DENIED'; END IF;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM production_real.priced_continuation_claims c WHERE c.claim_reference=NEW.claim_reference AND c.state IN ('accepted','dispatching'))
    THEN RAISE EXCEPTION 'PRICED_RESTORE_TERMINAL_CLAIM_DENIED'; END IF;
  END IF;
  NEW.updated_at=clock_timestamp(); RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS priced_restore_guard ON production_real.priced_continuation_restores;
CREATE TRIGGER priced_restore_guard BEFORE INSERT OR UPDATE OR DELETE ON production_real.priced_continuation_restores
  FOR EACH ROW EXECUTE FUNCTION production_real.guard_priced_restore();
CREATE OR REPLACE FUNCTION production_real.audit_priced_restore() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.state<>OLD.state THEN
    INSERT INTO production_real.priced_continuation_restore_audit(claim_reference,state) VALUES(NEW.claim_reference,NEW.state);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION production_real.audit_priced_restore() FROM PUBLIC;
DROP TRIGGER IF EXISTS priced_restore_audit ON production_real.priced_continuation_restores;
CREATE TRIGGER priced_restore_audit AFTER INSERT OR UPDATE ON production_real.priced_continuation_restores FOR EACH ROW EXECUTE FUNCTION production_real.audit_priced_restore();
DROP TRIGGER IF EXISTS priced_restore_audit_immutable ON production_real.priced_continuation_restore_audit;
CREATE TRIGGER priced_restore_audit_immutable BEFORE UPDATE OR DELETE ON production_real.priced_continuation_restore_audit
  FOR EACH ROW EXECUTE FUNCTION production_real.reject_phase04_append_only_change();
CREATE OR REPLACE FUNCTION production_real.fence_priced_restored_api_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM production_real.priced_continuation_claims c WHERE c.operation_id=NEW.operation_id) AND NOT EXISTS(
    SELECT 1 FROM production_real.priced_continuation_claims c
    JOIN production_real.priced_continuation_restores r ON r.claim_reference=c.claim_reference AND r.account_id=c.account_id
    JOIN production_real.priced_continuation_worker_allocations w ON w.claim_reference=c.claim_reference
    JOIN production_real.capacity_intents i ON i.account_id=w.account_id AND i.intent_reference=w.capacity_intent_reference AND i.capacity_reference=w.capacity_reference
    WHERE c.operation_id=NEW.operation_id AND r.state='restored' AND w.expires_at>clock_timestamp() AND i.state='available')
  THEN RAISE EXCEPTION 'PRICED_CONTINUATION_RESTORE_REQUIRED'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS priced_restored_api_claim_fence ON production_real.release_operation_journal;
CREATE TRIGGER priced_restored_api_claim_fence AFTER INSERT ON production_real.release_operation_journal
  FOR EACH ROW EXECUTE FUNCTION production_real.fence_priced_restored_api_claim();
REVOKE ALL ON production_real.priced_continuation_restores,production_real.priced_continuation_restore_audit FROM PUBLIC,napplet_production_real;
GRANT SELECT,INSERT ON production_real.priced_continuation_restores TO napplet_production_real;
GRANT UPDATE(state,proof_json,updated_at) ON production_real.priced_continuation_restores TO napplet_production_real;
GRANT SELECT ON production_real.priced_continuation_restore_audit TO napplet_production_real;
COMMIT;
