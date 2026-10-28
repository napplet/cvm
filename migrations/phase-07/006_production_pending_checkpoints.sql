BEGIN;
-- Expand the existing format binding without rewriting any retained manifest,
-- ciphertext, audit, object identity, permission or legacy reader evidence.
DO $$ DECLARE existing_name text; matches integer; BEGIN
  SELECT count(*),min(conname::text) INTO matches,existing_name FROM pg_catalog.pg_constraint
  WHERE conrelid='production_real.checkpoint_envelopes'::regclass AND contype='c'
    AND pg_catalog.pg_get_constraintdef(oid) LIKE '%schemaVersion%';
  IF matches<>1 THEN RAISE EXCEPTION 'CHECKPOINT_FORMAT_CONSTRAINT_REQUIRED'; END IF;
  EXECUTE format('ALTER TABLE production_real.checkpoint_envelopes DROP CONSTRAINT %I',existing_name);
  ALTER TABLE production_real.checkpoint_envelopes ADD CONSTRAINT checkpoint_manifest_format_binding CHECK((
    ((manifest_json->>'schemaVersion'='checkpoint-manifest-v1' AND NOT(manifest_json ? 'payloadKind'))
      OR (manifest_json->>'schemaVersion'='checkpoint-manifest-v2' AND manifest_json->>'payloadKind'='pending_command'
        AND manifest_json->>'sessionVersion'='0' AND manifest_json->>'actionVersion'='0'
        AND manifest_json->>'artifactVersion'='0' AND manifest_json->>'workspaceVersion'='0'
        AND manifest_json->'inventory'='["admission_state","compatibility_metadata","pending_action"]'::jsonb))
    AND manifest_json->>'checkpointId'=checkpoint_id AND manifest_json->>'accountId'=account_id AND manifest_json->>'sessionId'=session_id
    AND manifest_json->'action'->>'actionId'=action_id AND manifest_json->'action'->>'operationId'=operation_id
    AND (manifest_json->>'retentionUntil')::timestamptz=retention_until
  ) IS TRUE);
END $$;
COMMIT;
