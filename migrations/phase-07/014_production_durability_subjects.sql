BEGIN;
-- Expand only. Canonical checkpoint encryption/allocations remain owned by003.
-- Compatible with historical private007; do not replay private008/009.
CREATE TABLE IF NOT EXISTS production_real.durability_subjects (
  checkpoint_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('checkpoint','sealed_artifact','validation_evidence','usage_receipt','promotion_evidence','owner_event','attestation')),
  source_identity text NOT NULL,
  object_key text NOT NULL,
  object_generation bigint NOT NULL CHECK(object_generation>0),
  object_checksum char(64) NOT NULL,
  payload_sha256 char(64) NOT NULL,
  owner_id text NOT NULL,
  session_id text NOT NULL,
  action_id text NOT NULL,
  retention_until timestamptz NOT NULL,
  deletion_state text NOT NULL CHECK(deletion_state IN ('retained','tombstoned','deleted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(checkpoint_id,kind),
  UNIQUE(kind,source_identity,object_key,object_generation,object_checksum)
);

CREATE OR REPLACE FUNCTION production_real.guard_durability_subject() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'PRODUCTION_DURABILITY_DELETE_DENIED'; END IF;
  IF TG_OP='INSERT' THEN
    IF length(NEW.checkpoint_id) NOT BETWEEN 1 AND 256
       OR length(NEW.source_identity) NOT BETWEEN 1 AND 256
       OR length(NEW.owner_id) NOT BETWEEN 1 AND 256
       OR length(NEW.session_id) NOT BETWEEN 1 AND 256
       OR length(NEW.action_id) NOT BETWEEN 1 AND 256
       OR length(NEW.object_key) NOT BETWEEN 1 AND 2048
       OR NEW.object_generation NOT BETWEEN 1 AND 9007199254740991
       OR NEW.object_checksum::text !~* '^[a-f0-9]{64}$'
       OR NEW.payload_sha256::text !~* '^[a-f0-9]{64}$'
       OR NOT isfinite(NEW.retention_until) THEN
      RAISE EXCEPTION 'PRODUCTION_DURABILITY_SUBJECT_INVALID';
    END IF;
  ELSIF (to_jsonb(OLD)-ARRAY['deletion_state','updated_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['deletion_state','updated_at'])
     OR NOT ((OLD.deletion_state='retained' AND NEW.deletion_state IN ('tombstoned','deleted'))
       OR (OLD.deletion_state='tombstoned' AND NEW.deletion_state='deleted')) THEN
    RAISE EXCEPTION 'PRODUCTION_DURABILITY_IDENTITY_IMMUTABLE';
  END IF;
  IF TG_OP='UPDATE' THEN NEW.updated_at=clock_timestamp(); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS durability_subject_immutable ON production_real.durability_subjects;
CREATE TRIGGER durability_subject_immutable BEFORE INSERT OR UPDATE OR DELETE ON production_real.durability_subjects
  FOR EACH ROW EXECUTE FUNCTION production_real.guard_durability_subject();
DROP TRIGGER IF EXISTS durability_subject_no_truncate ON production_real.durability_subjects;
CREATE TRIGGER durability_subject_no_truncate BEFORE TRUNCATE ON production_real.durability_subjects
  FOR EACH STATEMENT EXECUTE FUNCTION production_real.guard_durability_subject();
REVOKE ALL ON production_real.durability_subjects FROM PUBLIC,napplet_production_real;
GRANT SELECT,INSERT ON production_real.durability_subjects TO napplet_production_real;
GRANT UPDATE(deletion_state,updated_at) ON production_real.durability_subjects TO napplet_production_real;
REVOKE ALL ON FUNCTION production_real.guard_durability_subject() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION production_real.guard_durability_subject() TO napplet_production_real;
COMMIT;
