-- One immutable realm marker per database. A database initialized for test
-- credits can never be started as the real-money service, and vice versa.
CREATE TABLE IF NOT EXISTS service_realm (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  realm text NOT NULL CHECK (realm IN ('test', 'real')),
  initialized_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_service_realm_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SERVICE_REALM_IMMUTABLE';
END;
$$;

DROP TRIGGER IF EXISTS service_realm_immutable ON service_realm;
CREATE TRIGGER service_realm_immutable BEFORE UPDATE OR DELETE ON service_realm
  FOR EACH ROW EXECUTE FUNCTION reject_service_realm_change();
