BEGIN;
-- A retained owner event is immutable producer history. The Phase 03 realm
-- clone copies the Phase 06 table but not its future source-record policy.
CREATE OR REPLACE FUNCTION production_real.guard_publication_signed_event() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'PRODUCTION_PUBLICATION_SIGNED_EVENT_IMMUTABLE';
END $$;
DROP TRIGGER IF EXISTS publication_signed_event_immutable ON production_real.publication_signed_events;
CREATE TRIGGER publication_signed_event_immutable BEFORE UPDATE OR DELETE ON production_real.publication_signed_events
  FOR EACH ROW EXECUTE FUNCTION production_real.guard_publication_signed_event();
REVOKE UPDATE, DELETE, TRUNCATE ON production_real.publication_signed_events FROM napplet_production_real;
GRANT SELECT, INSERT ON production_real.publication_signed_events TO napplet_production_real;
REVOKE ALL ON FUNCTION production_real.guard_publication_signed_event() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION production_real.guard_publication_signed_event() TO napplet_production_real;
COMMIT;
