CREATE TABLE provider_observations (
  operation_id text PRIMARY KEY REFERENCES source_proposals(operation_id) ON DELETE RESTRICT,
  provider_request_id text NOT NULL UNIQUE,
  provider_response_id text NOT NULL UNIQUE,
  source_proposal_sha256 text NOT NULL REFERENCES source_proposals(proposal_sha256) ON DELETE RESTRICT,
  receipt_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
