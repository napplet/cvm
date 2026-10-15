-- Unverified worker output has a separate authority from published artifacts.
-- A claimed operation is never automatically rebuilt after an ambiguous exit.
CREATE TABLE development_worker_results (
  request_sha256 text PRIMARY KEY CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  operation_id text NOT NULL UNIQUE REFERENCES source_proposals(operation_id),
  account_id text NOT NULL, session_id text NOT NULL, action_id text NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  proposal_sha256 text NOT NULL CHECK (proposal_sha256 ~ '^[a-f0-9]{64}$'),
  toolchain_sha256 text NOT NULL CHECK (toolchain_sha256 ~ '^[a-f0-9]{64}$'),
  claim_token uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('claimed', 'completed', 'failed')),
  manifest_sha256 text CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (state <> 'completed' OR manifest_sha256 IS NOT NULL),
  UNIQUE (account_id, session_id, action_id, expected_version)
);
