-- Phase 06 publication authority. These records fence external deployment and
-- relay effects; they are not a request or generation queue.
BEGIN;

CREATE TABLE IF NOT EXISTS publication_commands (
  command_id text PRIMARY KEY,
  principal_id text NOT NULL CHECK (length(principal_id) > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) > 0),
  request_fingerprint_sha256 char(64) NOT NULL CHECK (request_fingerprint_sha256 ~ '^[0-9a-fA-F]{64}$'),
  intent_id text NOT NULL UNIQUE CHECK (length(intent_id) > 0),
  result_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_id, idempotency_key),
  CHECK (result_json IS NULL OR jsonb_typeof(result_json) = 'object')
);

CREATE TABLE IF NOT EXISTS publication_intents (
  intent_id text PRIMARY KEY CHECK (length(intent_id) > 0),
  owner_principal_id text NOT NULL CHECK (length(owner_principal_id) > 0),
  session_id text NOT NULL REFERENCES metered_sessions(id),
  artifact_id text NOT NULL REFERENCES session_artifacts(id),
  artifact_version integer NOT NULL CHECK (artifact_version >= 0),
  artifact_sha256 char(64) NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-fA-F]{64}$'),
  manifest_sha256 char(64) NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-fA-F]{64}$'),
  aggregate_sha256 char(64) NOT NULL CHECK (aggregate_sha256 ~ '^[0-9a-fA-F]{64}$'),
  capability_digest char(64) NOT NULL CHECK (capability_digest ~ '^[0-9a-fA-F]{64}$'),
  normalized_d_tag text NOT NULL CHECK (normalized_d_tag ~ '^[a-z0-9][a-z0-9-]*$'),
  runtime_variant text NOT NULL CHECK (length(runtime_variant) > 0),
  policy_identity text NOT NULL CHECK (length(policy_identity) > 0),
  toolchain_identity text NOT NULL CHECK (length(toolchain_identity) > 0),
  runtime_compatibility_identity text NOT NULL CHECK (length(runtime_compatibility_identity) > 0),
  request_fingerprint_sha256 char(64) NOT NULL CHECK (request_fingerprint_sha256 ~ '^[0-9a-fA-F]{64}$'),
  owner_template_json jsonb NOT NULL,
  owner_template_sha256 char(64) NOT NULL CHECK (owner_template_sha256 ~ '^[0-9a-fA-F]{64}$'),
  state text NOT NULL CHECK (state IN ('intent_ready','signed','reconciliation_pending','partial','complete')),
  created_at_ms bigint NOT NULL CHECK (created_at_ms > 0),
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms > created_at_ms),
  record_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_principal_id, request_fingerprint_sha256),
  CHECK (jsonb_typeof(owner_template_json) = 'object'),
  CHECK (jsonb_typeof(record_json) = 'object')
);

ALTER TABLE publication_commands
  ADD CONSTRAINT publication_commands_intent_fk FOREIGN KEY (intent_id) REFERENCES publication_intents(intent_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS publication_effect_intents (
  effect_id text PRIMARY KEY CHECK (length(effect_id) > 0),
  intent_id text NOT NULL REFERENCES publication_intents(intent_id),
  effect_kind text NOT NULL CHECK (effect_kind IN ('deploy','owner_manifest','attestation')),
  operation_id text NOT NULL UNIQUE CHECK (length(operation_id) > 0),
  request_fingerprint_sha256 char(64) NOT NULL CHECK (request_fingerprint_sha256 ~ '^[0-9a-fA-F]{64}$'),
  state text NOT NULL CHECK (state IN ('created','dispatching','unknown','observed_failed','observed_partial','observed_complete')),
  claim_token text UNIQUE,
  observation_json jsonb,
  observation_sha256 char(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  observed_at timestamptz,
  UNIQUE (intent_id, effect_kind),
  CHECK ((observation_json IS NULL) = (observation_sha256 IS NULL)),
  CHECK ((state IN ('created','dispatching')) = (observation_json IS NULL))
);

-- Signed owner events are immutable owner-controlled publication input. The
-- coordinator stores only the signed public event, never a signer capability.
CREATE TABLE IF NOT EXISTS publication_signed_events (
  intent_id text PRIMARY KEY REFERENCES publication_intents(intent_id),
  event_id char(64) NOT NULL UNIQUE CHECK (event_id ~ '^[0-9a-fA-F]{64}$'),
  event_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(event_json) = 'object')
);

CREATE TABLE IF NOT EXISTS publication_records (
  intent_id text PRIMARY KEY REFERENCES publication_intents(intent_id),
  owner_event_id char(64) NOT NULL CHECK (owner_event_id ~ '^[0-9a-fA-F]{64}$'),
  attestation_event_id text NOT NULL CHECK (length(attestation_event_id) > 0),
  artifact_id text NOT NULL REFERENCES session_artifacts(id),
  aggregate_sha256 char(64) NOT NULL CHECK (aggregate_sha256 ~ '^[0-9a-fA-F]{64}$'),
  deployment_operation_id text NOT NULL UNIQUE REFERENCES publication_effect_intents(operation_id),
  owner_manifest_operation_id text NOT NULL UNIQUE REFERENCES publication_effect_intents(operation_id),
  attestation_operation_id text NOT NULL UNIQUE REFERENCES publication_effect_intents(operation_id),
  terminal_state text NOT NULL CHECK (terminal_state IN ('partial','complete')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((terminal_state = 'complete') OR terminal_state = 'partial')
);

-- Terminal observations are immutable. Unknown remains a durable lookup state
-- and may only be replaced by an observation of its original operation id.
CREATE OR REPLACE FUNCTION reject_phase06_publication_terminal_observation_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('observed_failed','observed_partial','observed_complete') AND
     (OLD.state <> NEW.state OR OLD.observation_json IS DISTINCT FROM NEW.observation_json OR OLD.observation_sha256 IS DISTINCT FROM NEW.observation_sha256) THEN
    RAISE EXCEPTION 'PHASE06_PUBLICATION_OBSERVATION_IMMUTABLE';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER publication_effect_terminal_observation_immutable
  BEFORE UPDATE ON publication_effect_intents
  FOR EACH ROW EXECUTE FUNCTION reject_phase06_publication_terminal_observation_change();

COMMIT;
