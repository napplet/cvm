-- Add after production accounting. Existing version rows/history are retained.
-- Runtime startup registers captured pricing by INSERT, never UPDATE.
CREATE OR REPLACE FUNCTION production_real.guard_pricing_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'PRODUCTION_PRICING_VERSION_IMMUTABLE';
END $$;
DROP TRIGGER IF EXISTS immutable_model_profile ON production_real.model_profile_versions;
CREATE TRIGGER immutable_model_profile BEFORE UPDATE OR DELETE ON production_real.model_profile_versions
FOR EACH ROW EXECUTE FUNCTION production_real.guard_pricing_version();
DROP TRIGGER IF EXISTS immutable_price_card ON production_real.price_card_versions;
CREATE TRIGGER immutable_price_card BEFORE UPDATE OR DELETE ON production_real.price_card_versions
FOR EACH ROW EXECUTE FUNCTION production_real.guard_pricing_version();
REVOKE UPDATE, DELETE, TRUNCATE ON production_real.model_profile_versions, production_real.price_card_versions FROM napplet_production_real;
GRANT SELECT, INSERT ON production_real.model_profile_versions, production_real.price_card_versions TO napplet_production_real;
