BEGIN;
-- Expand only. Never guess or bulk-rewrite legacy NULL owner associations.
CREATE TABLE IF NOT EXISTS production_real.account_owner_bindings (
 account_id text PRIMARY KEY REFERENCES production_real.funding_accounts(account_id),
 nostr_pubkey char(64) NOT NULL UNIQUE,
 bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(nostr_pubkey::text ~ '^[a-f0-9]{64}$'),
 CHECK(account_id='account:'||encode(sha256(convert_to(nostr_pubkey::text,'UTF8')),'hex'))
);
CREATE OR REPLACE FUNCTION production_real.guard_account_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.nostr_pubkey IS NOT NULL THEN RAISE EXCEPTION 'ACCOUNT_OWNER_IMMUTABLE'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.nostr_pubkey IS NOT NULL AND
   ROW(NEW.account_id,NEW.nostr_pubkey) IS DISTINCT FROM ROW(OLD.account_id,OLD.nostr_pubkey)
 THEN RAISE EXCEPTION 'ACCOUNT_OWNER_IMMUTABLE'; END IF;
 IF NEW.nostr_pubkey IS NOT NULL AND (NEW.nostr_pubkey::text !~ '^[a-f0-9]{64}$' OR
   NEW.account_id<>'account:'||encode(sha256(convert_to(NEW.nostr_pubkey::text,'UTF8')),'hex'))
 THEN RAISE EXCEPTION 'ACCOUNT_OWNER_HASH_MISMATCH'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION production_real.audit_account_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.nostr_pubkey IS NOT NULL AND (TG_OP='INSERT' OR OLD.nostr_pubkey IS NULL) THEN
  INSERT INTO production_real.account_owner_bindings(account_id,nostr_pubkey) VALUES(NEW.account_id,NEW.nostr_pubkey);
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION production_real.guard_owner_binding_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'ACCOUNT_OWNER_AUDIT_IMMUTABLE'; END $$;
DROP TRIGGER IF EXISTS immutable_account_owner ON production_real.funding_accounts;
CREATE TRIGGER immutable_account_owner BEFORE INSERT OR UPDATE OR DELETE ON production_real.funding_accounts FOR EACH ROW EXECUTE FUNCTION production_real.guard_account_owner();
DROP TRIGGER IF EXISTS record_account_owner ON production_real.funding_accounts;
CREATE TRIGGER record_account_owner AFTER INSERT OR UPDATE ON production_real.funding_accounts FOR EACH ROW EXECUTE FUNCTION production_real.audit_account_owner();
DROP TRIGGER IF EXISTS immutable_owner_binding_audit ON production_real.account_owner_bindings;
CREATE TRIGGER immutable_owner_binding_audit BEFORE UPDATE OR DELETE ON production_real.account_owner_bindings FOR EACH ROW EXECUTE FUNCTION production_real.guard_owner_binding_audit();
REVOKE ALL ON production_real.account_owner_bindings FROM PUBLIC;
GRANT SELECT,INSERT ON production_real.account_owner_bindings TO napplet_production_real;
REVOKE UPDATE,DELETE,TRUNCATE ON production_real.account_owner_bindings FROM napplet_production_real;
COMMIT;
