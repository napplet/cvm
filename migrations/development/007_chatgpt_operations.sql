-- Development only. Persist a dispatch fence before making a subscription request.
CREATE TABLE development_chatgpt_operations (
  operation_id text PRIMARY KEY,
  intent_sha256 text NOT NULL,
  observation_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
