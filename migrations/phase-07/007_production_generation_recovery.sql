BEGIN;
-- Expand only. Older writers may omit this archive; never infer old commands.
CREATE TABLE IF NOT EXISTS production_real.generation_recovery_commands (
 operation_id text PRIMARY KEY REFERENCES production_real.provider_operations(id),
 account_id text NOT NULL REFERENCES production_real.funding_accounts(account_id),
 action_id text NOT NULL UNIQUE REFERENCES production_real.metered_actions(id),
 binding_json jsonb NOT NULL CHECK(jsonb_typeof(binding_json)='object'),
 envelope_json jsonb,
 command_sha256 text NOT NULL CHECK(command_sha256 ~ '^[a-f0-9]{64}$'),
 retention_until timestamptz NOT NULL CHECK(isfinite(retention_until)),
 state text NOT NULL DEFAULT 'retained' CHECK(state IN ('retained','erased')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 erased_at timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 seconds',
 claim_token text,
 claim_until timestamptz,
 CHECK((claim_token IS NULL)=(claim_until IS NULL)),
 CHECK((state='retained' AND envelope_json IS NOT NULL AND erased_at IS NULL)
    OR (state='erased' AND envelope_json IS NULL AND erased_at IS NOT NULL)),
 CHECK(envelope_json IS NULL OR (octet_length(envelope_json::text)<=150000 AND
   envelope_json->>'schemaVersion'='protected-generation-command-v1' AND
   envelope_json->>'commandSha256'=command_sha256 AND
   to_timestamp((envelope_json->>'retentionUntilMs')::double precision/1000)=retention_until))
);
CREATE INDEX IF NOT EXISTS generation_recovery_due ON production_real.generation_recovery_commands(next_attempt_at,operation_id) WHERE state='retained';
CREATE OR REPLACE FUNCTION production_real.guard_generation_recovery_command() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GENERATION_RECOVERY_COMMAND_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM production_real.metered_actions a WHERE a.id=NEW.action_id AND a.account_id=NEW.account_id AND a.operation_id=NEW.operation_id
    AND NEW.binding_json->>'accountId'=a.account_id AND NEW.binding_json->>'sessionId'=a.session_id AND NEW.binding_json->>'actionId'=a.id
    AND NEW.binding_json->>'operationId'=a.operation_id AND NEW.binding_json->>'idempotencyKey'=a.idempotency_key
    AND NEW.binding_json->>'fingerprint'=a.fingerprint AND NEW.binding_json->>'admissionReference'=a.admission_reference
    AND NEW.binding_json->>'expectedVersion'=a.expected_session_version::text AND NEW.binding_json->>'maximum'=a.reservation_sat::text
    AND NEW.binding_json->>'profileId'=a.profile_id AND NEW.binding_json->>'priceCardId'=a.price_card_id)
    OR NEW.retention_until<=clock_timestamp() OR NEW.retention_until>clock_timestamp()+interval '2592000 seconds' OR NEW.state<>'retained'
  THEN RAISE EXCEPTION 'GENERATION_RECOVERY_COMMAND_BINDING_DENIED'; END IF;
 ELSE
  IF ROW(NEW.operation_id,NEW.account_id,NEW.action_id,NEW.binding_json,NEW.command_sha256,NEW.retention_until,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.operation_id,OLD.account_id,OLD.action_id,OLD.binding_json,OLD.command_sha256,OLD.retention_until,OLD.created_at)
    OR (NEW.envelope_json IS DISTINCT FROM OLD.envelope_json AND NOT(OLD.state='retained' AND NEW.state='erased' AND NEW.envelope_json IS NULL))
    OR (OLD.state='erased' AND ROW(NEW.state,NEW.erased_at) IS DISTINCT FROM ROW(OLD.state,OLD.erased_at))
  THEN RAISE EXCEPTION 'GENERATION_RECOVERY_COMMAND_IMMUTABLE'; END IF;
  IF OLD.state='retained' AND NEW.state='erased' AND OLD.retention_until>clock_timestamp()
    AND NOT EXISTS(SELECT 1 FROM production_real.metered_actions WHERE id=OLD.action_id AND terminal_result IS NOT NULL)
  THEN RAISE EXCEPTION 'GENERATION_RECOVERY_ERASURE_NOT_DUE'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_generation_recovery_command ON production_real.generation_recovery_commands;
CREATE TRIGGER immutable_generation_recovery_command BEFORE INSERT OR UPDATE OR DELETE ON production_real.generation_recovery_commands FOR EACH ROW EXECUTE FUNCTION production_real.guard_generation_recovery_command();
REVOKE ALL ON production_real.generation_recovery_commands FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON production_real.generation_recovery_commands TO napplet_production_real;
REVOKE DELETE,TRUNCATE ON production_real.generation_recovery_commands FROM napplet_production_real;
COMMIT;
