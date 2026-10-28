BEGIN;
-- Preserve all prior financial and artifact history. Source is accepted only
-- for an existing owner-bound paid action/operation, never as work admission.
CREATE UNIQUE INDEX IF NOT EXISTS source_proposal_action_binding ON production_real.metered_actions(id,account_id,session_id,expected_session_version,fingerprint);
CREATE TABLE IF NOT EXISTS production_real.source_proposals (
  operation_id text PRIMARY KEY REFERENCES production_real.provider_operations(id),
  proposal_sha256 text NOT NULL CHECK(proposal_sha256 ~ '^[a-f0-9]{64}$'),
  provider_request_id text NOT NULL CHECK(length(provider_request_id) BETWEEN 1 AND 256),
  account_id text NOT NULL,
  session_id text NOT NULL,
  action_id text NOT NULL,
  expected_version integer NOT NULL CHECK(expected_version>=0),
  request_fingerprint_sha256 text NOT NULL CHECK(request_fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  proposal_json jsonb NOT NULL CHECK(jsonb_typeof(proposal_json)='object' AND octet_length(proposal_json::text)<=100000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(action_id,account_id,session_id,expected_version,request_fingerprint_sha256) REFERENCES production_real.metered_actions(id,account_id,session_id,expected_session_version,fingerprint),
  FOREIGN KEY(action_id,operation_id) REFERENCES production_real.provider_operations(action_id,id),
  CHECK((proposal_json->>'sha256'=proposal_sha256 AND proposal_json->>'reference'='proposal:sha256:'||proposal_sha256) IS TRUE)
);
CREATE OR REPLACE FUNCTION production_real.guard_source_proposal_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'PRODUCTION_SOURCE_PROPOSAL_IMMUTABLE'; END $$;
DROP TRIGGER IF EXISTS source_proposal_immutable ON production_real.source_proposals;
CREATE TRIGGER source_proposal_immutable BEFORE UPDATE OR DELETE ON production_real.source_proposals FOR EACH ROW EXECUTE FUNCTION production_real.guard_source_proposal_immutable();
REVOKE ALL ON production_real.source_proposals FROM PUBLIC,napplet_production_real;
GRANT SELECT,INSERT ON production_real.source_proposals TO napplet_production_real;
COMMIT;
