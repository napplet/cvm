-- Custody precedes settlement. A pending rail payload cannot reference the
-- monetary top_ups row, which is created only after receipt verification.
-- Keep the account/rail/top-up identity enforced through an immutable scope.
DO $migration$
DECLARE prior_fk record;
BEGIN
  IF to_regnamespace('production_real') IS NULL THEN RETURN; END IF;
  CREATE TABLE IF NOT EXISTS production_real.rail_material_scopes (
    top_up_id text PRIMARY KEY,
    account_id text NOT NULL REFERENCES production_real.funding_accounts(account_id),
    rail text NOT NULL CHECK (rail IN ('cashu', 'lightning')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (top_up_id, account_id, rail)
  );
  INSERT INTO production_real.rail_material_scopes(top_up_id,account_id,rail)
    SELECT DISTINCT top_up_id,account_id,rail FROM production_real.protected_rail_material
    ON CONFLICT DO NOTHING;
  FOR prior_fk IN SELECT conname FROM pg_constraint
    WHERE conrelid='production_real.protected_rail_material'::regclass
      AND confrelid='production_real.top_ups'::regclass AND contype='f'
  LOOP
    EXECUTE format('ALTER TABLE production_real.protected_rail_material DROP CONSTRAINT %I', prior_fk.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='production_real.protected_rail_material'::regclass AND conname='protected_rail_material_scope_fk') THEN
    ALTER TABLE production_real.protected_rail_material ADD CONSTRAINT protected_rail_material_scope_fk
      FOREIGN KEY(top_up_id,account_id,rail) REFERENCES production_real.rail_material_scopes(top_up_id,account_id,rail);
  END IF;
  EXECUTE $function$
    CREATE OR REPLACE FUNCTION production_real.reject_rail_material_scope_change() RETURNS trigger
    LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'PRODUCTION_RAIL_MATERIAL_SCOPE_IMMUTABLE'; END $body$
  $function$;
  DROP TRIGGER IF EXISTS rail_material_scope_immutable ON production_real.rail_material_scopes;
  CREATE TRIGGER rail_material_scope_immutable BEFORE UPDATE OR DELETE ON production_real.rail_material_scopes
    FOR EACH ROW EXECUTE FUNCTION production_real.reject_rail_material_scope_change();
  GRANT SELECT, INSERT ON production_real.rail_material_scopes TO napplet_production_real;
  REVOKE UPDATE, DELETE, TRUNCATE ON production_real.rail_material_scopes FROM napplet_production_real;
END $migration$;
