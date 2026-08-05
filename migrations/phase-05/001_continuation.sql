-- Phase 05 continuation authority.  This schema adds paused-session recovery;
-- it is deliberately not a generation request queue.
BEGIN;

CREATE TABLE IF NOT EXISTS continuation_pauses (
  pause_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES funding_accounts(account_id),
  session_id text NOT NULL REFERENCES metered_sessions(id),
  admission_reference text NOT NULL REFERENCES admissions(reference),
  idempotency_key text NOT NULL,
  fingerprint_sha256 char(64) NOT NULL,
  pending_fingerprint_sha256 char(64) NOT NULL,
  pause_generation integer NOT NULL CHECK (pause_generation > 0),
  expected_session_version integer NOT NULL CHECK (expected_session_version >= 0),
  intent_json jsonb NOT NULL,
  grace_deadline_ms bigint NOT NULL,
  live_lease_token text,
  state text NOT NULL CHECK (state IN ('needs_top_up','resuming','wake_reconciliation','completed','checkpointing','resume_required','claimed','restored','expired')),
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key),
  UNIQUE (account_id, session_id, pause_generation),
  CHECK (intent_json ?& ARRAY['accountId','sessionId','idempotencyKey','fingerprint','reference','actionKind','boundedPayloadHash','expectedSessionVersion','expectedArtifactVersion','policyVersion','priceCardId','profileId','toolchainId','actionMaximum','admissionReference']),
  CHECK ((state IN ('needs_top_up','resuming','checkpointing')) = (live_lease_token IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS continuation_one_live_pause_per_session
  ON continuation_pauses(account_id, session_id)
  WHERE state NOT IN ('completed','expired');

-- This is a coupled effect intent for a single already-admitted wake, not a
-- request queue. The claim token fences the only coordinator allowed to call
-- the live worker; unknown outcomes require bounded reconciliation.
CREATE TABLE IF NOT EXISTS continuation_wake_dispatches (
  account_id text NOT NULL REFERENCES funding_accounts(account_id),
  session_id text NOT NULL REFERENCES metered_sessions(id),
  pause_generation integer NOT NULL,
  pending_fingerprint_sha256 char(64) NOT NULL,
  expected_session_version integer NOT NULL CHECK (expected_session_version >= 0),
  expected_artifact_version integer NOT NULL CHECK (expected_artifact_version >= 0),
  action_budget_reference text NOT NULL,
  operation_id text NOT NULL UNIQUE,
  live_lease_token text NOT NULL,
  claim_token text NOT NULL UNIQUE,
  reconciliation_attempts integer NOT NULL DEFAULT 0 CHECK (reconciliation_attempts >= 0 AND reconciliation_attempts <= 3),
  state text NOT NULL CHECK (state IN ('pending','claimed','completed','unknown','reconciliation_terminal')),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, session_id, pause_generation),
  FOREIGN KEY (account_id, session_id, pause_generation) REFERENCES continuation_pauses(account_id, session_id, pause_generation),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS continuation_checkpoints (
  checkpoint_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES funding_accounts(account_id),
  session_id text NOT NULL REFERENCES metered_sessions(id),
  pause_generation integer NOT NULL,
  expected_session_version integer NOT NULL CHECK (expected_session_version >= 0),
  expected_artifact_version integer NOT NULL CHECK (expected_artifact_version >= 0),
  manifest_reference text NOT NULL,
  object_key text NOT NULL,
  object_generation text NOT NULL,
  object_checksum char(64) NOT NULL,
  key_reference text NOT NULL,
  compatibility_identity text NOT NULL,
  checkpoint_committed_at_ms bigint NOT NULL,
  retention_deadline_ms bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('resume_required','claimed','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, session_id, pause_generation),
  UNIQUE (object_key, object_generation),
  FOREIGN KEY (account_id, session_id, pause_generation) REFERENCES continuation_pauses(account_id, session_id, pause_generation),
  CHECK (retention_deadline_ms = checkpoint_committed_at_ms + 2592000000)
);

CREATE TABLE IF NOT EXISTS continuation_resume_commands (
  command_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES funding_accounts(account_id),
  checkpoint_id text NOT NULL REFERENCES continuation_checkpoints(checkpoint_id),
  idempotency_key text NOT NULL,
  fingerprint_sha256 char(64) NOT NULL,
  pending_fingerprint_sha256 char(64) NOT NULL,
  expected_checkpoint_version integer NOT NULL CHECK (expected_checkpoint_version = 1),
  expected_session_version integer NOT NULL CHECK (expected_session_version >= 0),
  lease_token text NOT NULL UNIQUE,
  allocation_intent_reference text NOT NULL UNIQUE,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key),
  UNIQUE (checkpoint_id)
);

CREATE TABLE IF NOT EXISTS continuation_restore_observations (
  checkpoint_id text NOT NULL REFERENCES continuation_checkpoints(checkpoint_id),
  allocation_intent_reference text NOT NULL,
  state text NOT NULL CHECK (state IN ('restored','refused','reconciliation_pending')),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (checkpoint_id, allocation_intent_reference)
);

CREATE TABLE IF NOT EXISTS continuation_tombstones (
  checkpoint_id text PRIMARY KEY REFERENCES continuation_checkpoints(checkpoint_id),
  account_id text NOT NULL REFERENCES funding_accounts(account_id),
  expired_at_ms bigint NOT NULL,
  deletion_scheduled_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS continuation_deletions (
  checkpoint_id text NOT NULL REFERENCES continuation_checkpoints(checkpoint_id),
  object_generation text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  state text NOT NULL CHECK (state IN ('scheduled','deleted','failed','unknown')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (checkpoint_id, object_generation, attempt)
);

-- Immutable checkpoint identity and append-only terminal evidence prevent a
-- retry from silently replacing archival bytes or reopening an expired session.
CREATE OR REPLACE FUNCTION reject_phase05_continuation_identity_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.object_key <> NEW.object_key OR OLD.object_generation <> NEW.object_generation OR OLD.object_checksum <> NEW.object_checksum OR OLD.retention_deadline_ms <> NEW.retention_deadline_ms THEN
    RAISE EXCEPTION 'PHASE05_CHECKPOINT_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER continuation_checkpoint_identity_immutable BEFORE UPDATE ON continuation_checkpoints FOR EACH ROW EXECUTE FUNCTION reject_phase05_continuation_identity_change();
CREATE TRIGGER continuation_tombstones_append_only BEFORE UPDATE OR DELETE ON continuation_tombstones FOR EACH ROW EXECUTE FUNCTION reject_phase04_append_only_change();

COMMIT;
