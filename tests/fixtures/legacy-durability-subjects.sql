-- Applied only after the production accounting and operation-journal migrations.
-- This is a controller-owned registry of exact retained GCS generations; it
-- stores no archive bytes, credential material, or mutable "latest" pointer.
CREATE TABLE IF NOT EXISTS production_real.durability_subjects (
  checkpoint_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('checkpoint','sealed_artifact','validation_evidence','usage_receipt','promotion_evidence','owner_event','attestation')),
  source_identity text NOT NULL,
  object_key text NOT NULL,
  object_generation bigint NOT NULL CHECK (object_generation > 0),
  object_checksum char(64) NOT NULL,
  payload_sha256 char(64) NOT NULL,
  owner_id text NOT NULL,
  session_id text NOT NULL,
  action_id text NOT NULL,
  retention_until timestamptz NOT NULL,
  deletion_state text NOT NULL CHECK (deletion_state IN ('retained','tombstoned','deleted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (checkpoint_id, kind),
  UNIQUE (kind, source_identity, object_key, object_generation, object_checksum)
);
REVOKE ALL ON production_real.durability_subjects FROM PUBLIC;
-- The restricted production controller owns the exact retained-object
-- registry.  It needs no DDL or DELETE authority, but it must be able to
-- register, inventory, and advance a retained subject to a terminal deletion
-- state during the original-operation restore/reaper paths.
GRANT SELECT, INSERT, UPDATE ON production_real.durability_subjects TO napplet_production_real;
