-- Immutable provider-report capture references. Raw response bytes remain in
-- the versioned object store; this relation only binds their exact generation
-- and digest to the controller-created observation grant.
CREATE TABLE IF NOT EXISTS production_real.authoritative_usage_report_capture (
  report_request_sha256 text PRIMARY KEY CHECK(report_request_sha256 ~ '^[a-f0-9]{64}$'),
  grant_sha256 text NOT NULL CHECK(grant_sha256 ~ '^[a-f0-9]{64}$'),
  operation_record_sha256 text NOT NULL CHECK(operation_record_sha256 ~ '^[a-f0-9]{64}$'),
  provider_job_id text NOT NULL CHECK(length(provider_job_id) BETWEEN 1 AND 1024 AND provider_job_id ~ '^[A-Za-z0-9_-]+$'),
  artifact_uri text NOT NULL CHECK(artifact_uri ~ '^gs://[^[:space:]]+$'),
  artifact_generation bigint NOT NULL CHECK(artifact_generation > 0),
  raw_report_sha256 text NOT NULL CHECK(raw_report_sha256 ~ '^[a-f0-9]{64}$'),
  envelope_json jsonb NOT NULL CHECK(octet_length(envelope_json::text) <= 1048576),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(grant_sha256),
  UNIQUE(artifact_uri, artifact_generation)
);

CREATE OR REPLACE FUNCTION production_real.guard_authoritative_usage_report_capture() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'AUTHORITATIVE_USAGE_REPORT_CAPTURE_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION production_real.guard_authoritative_usage_report_capture() FROM PUBLIC;
DROP TRIGGER IF EXISTS authoritative_usage_report_capture_guard ON production_real.authoritative_usage_report_capture;
CREATE TRIGGER authoritative_usage_report_capture_guard BEFORE UPDATE OR DELETE ON production_real.authoritative_usage_report_capture FOR EACH ROW EXECUTE FUNCTION production_real.guard_authoritative_usage_report_capture();
REVOKE ALL ON production_real.authoritative_usage_report_capture FROM PUBLIC, napplet_production_real;
GRANT SELECT, INSERT ON production_real.authoritative_usage_report_capture TO napplet_production_real;
