BEGIN;
CREATE TABLE IF NOT EXISTS development_artifacts (
  artifact_id text PRIMARY KEY CHECK (artifact_id ~ '^artifact:sha256:[a-f0-9]{64}$'),
  account_id text NOT NULL, session_id text NOT NULL, action_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 0), proposal_sha256 text NOT NULL CHECK (proposal_sha256 ~ '^[a-f0-9]{64}$'),
  toolchain_sha256 text NOT NULL CHECK (toolchain_sha256 ~ '^[a-f0-9]{64}$'), aggregate_sha256 text NOT NULL CHECK (aggregate_sha256 ~ '^[a-f0-9]{64}$'),
  sealed_object_sha256 text NOT NULL CHECK (sealed_object_sha256 ~ '^[a-f0-9]{64}$'), verification_evidence_sha256 text NOT NULL CHECK (verification_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  object_key text NOT NULL UNIQUE, files_json jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, session_id, action_id, version)
);
CREATE TABLE IF NOT EXISTS development_preview_grants (
  preview_grant_id text PRIMARY KEY, token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  account_id text NOT NULL, session_id text NOT NULL, artifact_id text NOT NULL REFERENCES development_artifacts(artifact_id),
  expires_at timestamptz NOT NULL, revoked_at timestamptz NULL, created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
