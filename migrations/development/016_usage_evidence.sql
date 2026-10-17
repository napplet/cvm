-- Preserve valid provider usage before parsing or storing untrusted generated source.
CREATE TABLE development_usage_evidence (
  operation_id text PRIMARY KEY,
  intent_sha256 text NOT NULL CHECK (intent_sha256 ~ '^[a-f0-9]{64}$'),
  receipt_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER development_usage_evidence_append_only BEFORE UPDATE OR DELETE
ON development_usage_evidence FOR EACH ROW EXECUTE FUNCTION reject_phase04_append_only_change();
CREATE UNIQUE INDEX development_usage_evidence_provider_receipt
  ON development_usage_evidence ((receipt_json->>'provider'),(receipt_json->>'model'),(receipt_json->'provenance'->>'protectedEvidenceReference'));
