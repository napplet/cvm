-- Development pre-admission authority.  This table intentionally has no
-- relationship to sessions, holds, action reservations, provider operations,
-- workers, artifacts, or legacy continuation checkpoints.
BEGIN;

CREATE TABLE development_pending_actions (
  checkpoint_id text PRIMARY KEY,
  owner_id text NOT NULL CHECK (owner_id ~ '^[a-f0-9]{64}$'),
  account_id text NOT NULL REFERENCES funding_accounts(account_id),
  idempotency_key text NOT NULL,
  command_fingerprint_sha256 text NOT NULL CHECK (command_fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  action_reference text NOT NULL,
  maximum_sat bigint NOT NULL CHECK (maximum_sat > 0),
  envelope_json jsonb NOT NULL,
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms > 0),
  state text NOT NULL CHECK (state IN ('saved','bound','completed','failed')),
  admission_reference text,
  resume_idempotency_key text,
  resume_fingerprint_sha256 text CHECK (resume_fingerprint_sha256 IS NULL OR resume_fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  operation_id text,
  terminal_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key),
  UNIQUE (account_id, action_reference),
  UNIQUE (account_id, resume_idempotency_key),
  CHECK (
    (state = 'saved' AND admission_reference IS NULL AND resume_idempotency_key IS NULL AND resume_fingerprint_sha256 IS NULL AND operation_id IS NULL AND terminal_result IS NULL)
    OR (state = 'bound' AND admission_reference IS NOT NULL AND resume_idempotency_key IS NOT NULL AND resume_fingerprint_sha256 IS NOT NULL)
    OR (state IN ('completed','failed') AND admission_reference IS NOT NULL AND resume_idempotency_key IS NOT NULL AND resume_fingerprint_sha256 IS NOT NULL AND operation_id IS NOT NULL AND terminal_result IS NOT NULL)
  )
);

CREATE INDEX development_pending_actions_owner_checkpoint
  ON development_pending_actions (account_id, checkpoint_id);
CREATE INDEX development_pending_actions_expiry
  ON development_pending_actions (expires_at_ms) WHERE state IN ('saved','bound');

COMMIT;
