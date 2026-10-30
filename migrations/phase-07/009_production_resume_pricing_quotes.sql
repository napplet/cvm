BEGIN;
-- Metadata proposals only. These rows cannot reserve funds or admit work.
CREATE TABLE IF NOT EXISTS production_real.resume_pricing_quotes (
  quote_reference text PRIMARY KEY,
  quote_sha256 text NOT NULL UNIQUE CHECK (quote_sha256 ~ '^[a-f0-9]{64}$'),
  account_id text NOT NULL REFERENCES production_real.funding_accounts(account_id),
  checkpoint_id text NOT NULL REFERENCES production_real.continuation_checkpoints(checkpoint_id),
  preparation_key text NOT NULL CHECK (length(preparation_key) BETWEEN 1 AND 256),
  quote_json jsonb NOT NULL CHECK (jsonb_typeof(quote_json)='object' AND octet_length(quote_json::text)<=65536),
  prepared_at_ms bigint NOT NULL CHECK (prepared_at_ms BETWEEN 0 AND 9007199254740991),
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms>prepared_at_ms AND expires_at_ms<=prepared_at_ms+300000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id,preparation_key),
  CHECK (quote_reference='resume-quote:'||quote_sha256),
  CHECK (quote_json ?& ARRAY['schemaVersion','quoteReference','quoteSha256','preparationKey','preparedAtMs','expiresAtMs','context','pricing','maximumUsdMicros','maximumSat','priceSourcesSha256']
    AND quote_json->'context' ?& ARRAY['realm','accountId','sessionId','checkpointId','checkpointSha256','checkpointVersion','expectedSessionVersion','expectedArtifactVersion','pendingAction','commandSha256','originalOperationId','originalSettlementSha256','originalCommandMaximum','policyVersion','toolchainId','retentionUntilMs']
    AND quote_json->>'schemaVersion'='resume-pricing-quote-v1'
    AND quote_json->>'quoteReference'=quote_reference AND quote_json->>'quoteSha256'=quote_sha256
    AND quote_json->>'preparationKey'=preparation_key
    AND (quote_json->>'preparedAtMs')::bigint=prepared_at_ms AND (quote_json->>'expiresAtMs')::bigint=expires_at_ms
    AND quote_json->'context'->>'realm'='production-real'
    AND quote_json->'context'->>'accountId'=account_id AND quote_json->'context'->>'checkpointId'=checkpoint_id)
);
CREATE OR REPLACE FUNCTION production_real.guard_resume_pricing_quote() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'RESUME_PRICING_QUOTE_IMMUTABLE'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM production_real.continuation_checkpoints c
    JOIN production_real.continuation_pauses p ON p.account_id=c.account_id AND p.session_id=c.session_id AND p.pause_generation=c.pause_generation
    WHERE c.checkpoint_id=NEW.checkpoint_id AND c.account_id=NEW.account_id AND c.state='resume_required'
      AND c.session_id=NEW.quote_json->'context'->>'sessionId'
      AND c.expected_session_version=(NEW.quote_json->'context'->>'expectedSessionVersion')::integer
      AND c.expected_artifact_version=(NEW.quote_json->'context'->>'expectedArtifactVersion')::integer
      AND c.retention_deadline_ms=(NEW.quote_json->'context'->>'retentionUntilMs')::bigint
      AND c.retention_deadline_ms>=NEW.expires_at_ms
      AND p.pending_fingerprint_sha256=NEW.quote_json->'context'->'pendingAction'->>'fingerprint'
  ) THEN RAISE EXCEPTION 'RESUME_PRICING_QUOTE_OWNER_BINDING_DENIED'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_resume_pricing_quote ON production_real.resume_pricing_quotes;
CREATE TRIGGER immutable_resume_pricing_quote BEFORE INSERT OR UPDATE OR DELETE ON production_real.resume_pricing_quotes
  FOR EACH ROW EXECUTE FUNCTION production_real.guard_resume_pricing_quote();
REVOKE ALL ON production_real.resume_pricing_quotes FROM PUBLIC,napplet_production_real;
GRANT SELECT,INSERT ON production_real.resume_pricing_quotes TO napplet_production_real;
COMMIT;
