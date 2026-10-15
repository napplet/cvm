CREATE TABLE source_proposals (
  proposal_sha256 text PRIMARY KEY CHECK (proposal_sha256 ~ '^[a-f0-9]{64}$'),
  operation_id text NOT NULL UNIQUE,
  provider_request_id text NOT NULL UNIQUE,
  account_id text NOT NULL,
  session_id text NOT NULL,
  action_id text NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  request_fingerprint_sha256 text NOT NULL CHECK (request_fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  prior_artifact_reference text,
  provider text NOT NULL,
  model text NOT NULL,
  profile_id text NOT NULL,
  price_card_id text NOT NULL,
  proposal_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, session_id, action_id, expected_version)
);

CREATE INDEX source_proposals_owner_operation ON source_proposals(account_id, operation_id);
