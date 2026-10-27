-- Apply after the production accounting authority. No development table or balance is copied.
CREATE TABLE IF NOT EXISTS production_real.release_operation_journal (
  namespace text NOT NULL CHECK(namespace ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$'),
  scope_sha256 text NOT NULL CHECK(scope_sha256 ~ '^[a-f0-9]{64}$'),
  operation_id text NOT NULL CHECK(operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$'),
  identity_sha256 text NOT NULL CHECK(identity_sha256 ~ '^[a-f0-9]{64}$'),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
  value_json jsonb NOT NULL CHECK(octet_length(value_json::text) <= 2097152),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(namespace,scope_sha256,operation_id)
);
CREATE TABLE IF NOT EXISTS production_real.release_operation_audit (
  namespace text NOT NULL, scope_sha256 text NOT NULL, operation_id text NOT NULL,
  identity_sha256 text NOT NULL, revision bigint NOT NULL, value_json jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(namespace,scope_sha256,operation_id,revision),
  FOREIGN KEY(namespace,scope_sha256,operation_id) REFERENCES production_real.release_operation_journal(namespace,scope_sha256,operation_id)
);
CREATE OR REPLACE FUNCTION production_real.guard_release_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'OPERATION_JOURNAL_DELETE_DENIED'; END IF;
  IF TG_OP = 'INSERT' AND NEW.revision <> 1 THEN RAISE EXCEPTION 'OPERATION_INITIAL_REVISION_INVALID'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.namespace <> OLD.namespace OR NEW.scope_sha256 <> OLD.scope_sha256 OR NEW.operation_id <> OLD.operation_id OR NEW.identity_sha256 <> OLD.identity_sha256 OR NEW.created_at <> OLD.created_at OR NEW.revision <> OLD.revision + 1) THEN
    RAISE EXCEPTION 'OPERATION_IDENTITY_OR_REVISION_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION production_real.audit_release_operation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO production_real.release_operation_audit(namespace,scope_sha256,operation_id,identity_sha256,revision,value_json)
    VALUES(NEW.namespace,NEW.scope_sha256,NEW.operation_id,NEW.identity_sha256,NEW.revision,NEW.value_json);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION production_real.audit_release_operation() FROM PUBLIC;
DROP TRIGGER IF EXISTS release_operation_guard ON production_real.release_operation_journal;
CREATE TRIGGER release_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON production_real.release_operation_journal FOR EACH ROW EXECUTE FUNCTION production_real.guard_release_operation();
DROP TRIGGER IF EXISTS release_operation_audit ON production_real.release_operation_journal;
CREATE TRIGGER release_operation_audit AFTER INSERT OR UPDATE ON production_real.release_operation_journal FOR EACH ROW EXECUTE FUNCTION production_real.audit_release_operation();
REVOKE ALL ON production_real.release_operation_journal, production_real.release_operation_audit FROM PUBLIC, napplet_production_real;
GRANT SELECT, INSERT ON production_real.release_operation_journal TO napplet_production_real;
GRANT UPDATE(value_json,revision,updated_at) ON production_real.release_operation_journal TO napplet_production_real;
GRANT SELECT ON production_real.release_operation_audit TO napplet_production_real;
