BEGIN;
-- Expand only: retain all ledger/session/history rows. Install after production
-- accounting and operation journals, before enabling the checkpoint runtime.
CREATE TABLE IF NOT EXISTS production_real.checkpoint_crypto_records (
  checkpoint_id text PRIMARY KEY CHECK(length(checkpoint_id) BETWEEN 1 AND 256),
  key_reference text NOT NULL UNIQUE CHECK(length(key_reference) BETWEEN 1 AND 256),
  binding_sha256 text NOT NULL CHECK(binding_sha256 ~ '^[a-f0-9]{64}$'),
  account_id text NOT NULL REFERENCES production_real.funding_accounts(account_id),
  session_id text NOT NULL,
  action_id text NOT NULL CHECK(length(action_id) BETWEEN 1 AND 256),
  operation_id text NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 256),
  retention_until timestamptz NOT NULL CHECK(isfinite(retention_until)),
  plaintext_sha256 text NOT NULL CHECK(plaintext_sha256 ~ '^[a-f0-9]{64}$'),
  aad_sha256 text NOT NULL CHECK(aad_sha256 ~ '^[a-f0-9]{64}$'),
  ciphertext_sha256 text NOT NULL CHECK(ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
  wrap_nonce bytea NOT NULL CHECK(octet_length(wrap_nonce)=12),
  wrapped_dek bytea CHECK(wrapped_dek IS NULL OR octet_length(wrapped_dek)=48),
  ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 0 AND 33554448),
  state text NOT NULL CHECK(state IN ('active','destroyed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  destroyed_at timestamptz,
  FOREIGN KEY(account_id,session_id) REFERENCES production_real.metered_sessions(account_id,id),
  UNIQUE(checkpoint_id,key_reference),
  UNIQUE(checkpoint_id,key_reference,account_id,session_id,action_id,operation_id,retention_until,ciphertext_sha256),
  CHECK((state='active' AND wrapped_dek IS NOT NULL AND destroyed_at IS NULL AND octet_length(ciphertext)>=17)
     OR (state='destroyed' AND wrapped_dek IS NULL AND destroyed_at IS NOT NULL AND octet_length(ciphertext)=0))
);
CREATE TABLE IF NOT EXISTS production_real.checkpoint_crypto_audit (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  checkpoint_id text NOT NULL, key_reference text NOT NULL,
  event text NOT NULL CHECK(event IN ('sealed','opened','destroyed')),
  details_sha256 text NOT NULL CHECK(details_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(checkpoint_id,key_reference) REFERENCES production_real.checkpoint_crypto_records(checkpoint_id,key_reference)
);
CREATE TABLE IF NOT EXISTS production_real.checkpoint_envelopes (
  checkpoint_id text PRIMARY KEY, account_id text NOT NULL, session_id text NOT NULL,
  action_id text NOT NULL, operation_id text NOT NULL,
  manifest_json jsonb NOT NULL CHECK(jsonb_typeof(manifest_json)='object' AND octet_length(manifest_json::text)<=1048576),
  object_key text NOT NULL CHECK(length(object_key) BETWEEN 1 AND 2048),
  object_generation bigint NOT NULL CHECK(object_generation BETWEEN 1 AND 9007199254740991),
  object_checksum text NOT NULL CHECK(object_checksum ~ '^[a-f0-9]{64}$'),
  key_reference text NOT NULL UNIQUE,
  retention_until timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('retained','destroyed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), destroyed_at timestamptz,
  FOREIGN KEY(checkpoint_id,key_reference,account_id,session_id,action_id,operation_id,retention_until,object_checksum)
    REFERENCES production_real.checkpoint_crypto_records(checkpoint_id,key_reference,account_id,session_id,action_id,operation_id,retention_until,ciphertext_sha256),
  UNIQUE(object_key,object_generation),
  CHECK((manifest_json->>'schemaVersion'='checkpoint-manifest-v1' AND manifest_json->>'checkpointId'=checkpoint_id AND manifest_json->>'accountId'=account_id AND manifest_json->>'sessionId'=session_id
    AND manifest_json->'action'->>'actionId'=action_id AND manifest_json->'action'->>'operationId'=operation_id
    AND (manifest_json->>'retentionUntil')::timestamptz=retention_until) IS TRUE),
  CHECK((state='retained' AND destroyed_at IS NULL) OR (state='destroyed' AND destroyed_at IS NOT NULL))
);
-- These indexes express owner binding on existing globally unique identities;
-- they neither rewrite state nor introduce an admission request queue.
CREATE UNIQUE INDEX IF NOT EXISTS continuation_checkpoint_owner ON production_real.continuation_checkpoints(checkpoint_id,account_id,session_id);
CREATE UNIQUE INDEX IF NOT EXISTS continuation_action_owner ON production_real.metered_actions(id,account_id,session_id);
CREATE UNIQUE INDEX IF NOT EXISTS continuation_capacity_owner ON production_real.capacity_intents(account_id,intent_reference,capacity_reference);
CREATE UNIQUE INDEX IF NOT EXISTS continuation_resume_owner ON production_real.continuation_resume_commands(checkpoint_id,account_id,action_id,allocation_intent_reference);
CREATE TABLE IF NOT EXISTS production_real.continuation_worker_allocations (
  checkpoint_id text PRIMARY KEY, account_id text NOT NULL, session_id text NOT NULL,
  action_id text NOT NULL UNIQUE, allocation_intent_reference text NOT NULL UNIQUE,
  capacity_intent_reference text NOT NULL UNIQUE, capacity_reference text NOT NULL,
  state text NOT NULL CHECK(state='available'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(checkpoint_id,account_id,session_id) REFERENCES production_real.continuation_checkpoints(checkpoint_id,account_id,session_id),
  FOREIGN KEY(action_id,account_id,session_id) REFERENCES production_real.metered_actions(id,account_id,session_id),
  FOREIGN KEY(account_id,capacity_intent_reference,capacity_reference) REFERENCES production_real.capacity_intents(account_id,intent_reference,capacity_reference),
  FOREIGN KEY(checkpoint_id,account_id,action_id,allocation_intent_reference) REFERENCES production_real.continuation_resume_commands(checkpoint_id,account_id,action_id,allocation_intent_reference)
);
CREATE OR REPLACE FUNCTION production_real.guard_checkpoint_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PRODUCTION_CHECKPOINT_DELETE_DENIED'; END IF;
  IF TG_TABLE_NAME='checkpoint_crypto_records' THEN
    IF OLD.state<>'active' OR NEW.state<>'destroyed' OR NEW.wrapped_dek IS NOT NULL OR octet_length(NEW.ciphertext)<>0 OR NEW.destroyed_at IS NULL
       OR (to_jsonb(OLD)-ARRAY['state','wrapped_dek','ciphertext','destroyed_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','wrapped_dek','ciphertext','destroyed_at']) THEN
      RAISE EXCEPTION 'PRODUCTION_CHECKPOINT_IDENTITY_IMMUTABLE';
    END IF;
  ELSIF TG_TABLE_NAME='checkpoint_envelopes' THEN
    IF OLD.state<>'retained' OR NEW.state<>'destroyed' OR NEW.destroyed_at IS NULL
       OR (to_jsonb(OLD)-ARRAY['state','destroyed_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','destroyed_at']) THEN
      RAISE EXCEPTION 'PRODUCTION_CHECKPOINT_IDENTITY_IMMUTABLE';
    END IF;
  ELSE RAISE EXCEPTION 'PRODUCTION_CHECKPOINT_AUDIT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS checkpoint_crypto_immutable ON production_real.checkpoint_crypto_records;
CREATE TRIGGER checkpoint_crypto_immutable BEFORE UPDATE OR DELETE ON production_real.checkpoint_crypto_records FOR EACH ROW EXECUTE FUNCTION production_real.guard_checkpoint_transition();
DROP TRIGGER IF EXISTS checkpoint_envelope_immutable ON production_real.checkpoint_envelopes;
CREATE TRIGGER checkpoint_envelope_immutable BEFORE UPDATE OR DELETE ON production_real.checkpoint_envelopes FOR EACH ROW EXECUTE FUNCTION production_real.guard_checkpoint_transition();
DROP TRIGGER IF EXISTS checkpoint_audit_immutable ON production_real.checkpoint_crypto_audit;
CREATE TRIGGER checkpoint_audit_immutable BEFORE UPDATE OR DELETE ON production_real.checkpoint_crypto_audit FOR EACH ROW EXECUTE FUNCTION production_real.guard_checkpoint_transition();
DROP TRIGGER IF EXISTS checkpoint_allocation_immutable ON production_real.continuation_worker_allocations;
CREATE TRIGGER checkpoint_allocation_immutable BEFORE UPDATE OR DELETE ON production_real.continuation_worker_allocations FOR EACH ROW EXECUTE FUNCTION production_real.guard_checkpoint_transition();
REVOKE ALL ON production_real.checkpoint_crypto_records,production_real.checkpoint_crypto_audit,production_real.checkpoint_envelopes,production_real.continuation_worker_allocations FROM PUBLIC,napplet_production_real;
GRANT SELECT,INSERT ON production_real.checkpoint_crypto_records,production_real.checkpoint_crypto_audit,production_real.checkpoint_envelopes,production_real.continuation_worker_allocations TO napplet_production_real;
GRANT UPDATE(wrapped_dek,ciphertext,state,destroyed_at) ON production_real.checkpoint_crypto_records TO napplet_production_real;
GRANT UPDATE(state,destroyed_at) ON production_real.checkpoint_envelopes TO napplet_production_real;
GRANT USAGE ON SEQUENCE production_real.checkpoint_crypto_audit_sequence_seq TO napplet_production_real;

COMMIT;
