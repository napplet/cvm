BEGIN;
ALTER TABLE metered_actions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE development_publications (
  id text PRIMARY KEY, account_id text NOT NULL, session_id text NOT NULL,
  artifact_id text NOT NULL REFERENCES development_artifacts(artifact_id),
  publisher text NOT NULL, request_key text NOT NULL, fingerprint text NOT NULL,
  prepared jsonb NOT NULL, signed_event jsonb,
  state text NOT NULL CHECK(state IN ('prepared','publishing','published','unconfirmed')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,request_key)
);
COMMIT;
