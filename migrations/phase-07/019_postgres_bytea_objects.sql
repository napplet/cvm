BEGIN;
-- Additive candidate storage only.  The existing ledger, checkpoint crypto and
-- historical object readers remain authoritative for their records.
DO $$ BEGIN CREATE ROLE napplet_production_object NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS production_real.immutable_object_key_heads (
  object_key text PRIMARY KEY CHECK(length(object_key) BETWEEN 1 AND 2048),
  -- Zero is an internal exhausted sentinel; persisted object generations are
  -- always positive JavaScript-safe integers.
  next_generation bigint NOT NULL CHECK(next_generation BETWEEN 0 AND 9007199254740991)
);

CREATE TABLE IF NOT EXISTS production_real.immutable_object_generations (
  object_key text NOT NULL CHECK(length(object_key) BETWEEN 1 AND 2048),
  generation bigint NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
  original_operation_identity char(64) NOT NULL CHECK(original_operation_identity ~ '^[a-f0-9]{64}$'),
  checksum char(64) NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
  byte_count bigint NOT NULL CHECK(byte_count >= 0),
  chunk_count integer NOT NULL CHECK(chunk_count >= 0),
  retention_until timestamptz NOT NULL CHECK(isfinite(retention_until)),
  delete_after timestamptz,
  state text NOT NULL CHECK(state IN ('writing','sealed','deleting','tombstoned')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sealed_at timestamptz,
  deleted_at timestamptz,
  PRIMARY KEY(object_key,generation),
  CHECK((state='writing' AND sealed_at IS NULL AND deleted_at IS NULL)
     OR (state='sealed' AND sealed_at IS NOT NULL AND deleted_at IS NULL)
     OR (state='deleting' AND sealed_at IS NOT NULL AND deleted_at IS NULL)
     OR (state='tombstoned' AND sealed_at IS NOT NULL AND deleted_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS production_real.immutable_object_chunks (
  object_key text NOT NULL,
  generation bigint NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal >= 0),
  bytes bytea NOT NULL,
  PRIMARY KEY(object_key,generation,ordinal),
  FOREIGN KEY(object_key,generation) REFERENCES production_real.immutable_object_generations(object_key,generation) ON DELETE RESTRICT
);

-- This record deliberately precedes filesystem key material.  The candidate
-- can therefore retain a durable, original-identity-bound erasure intent when
-- a process dies between a filesystem operation and its acknowledgement.
CREATE TABLE IF NOT EXISTS production_real.checkpoint_object_key_custody (
  checkpoint_id text PRIMARY KEY,
  key_reference text NOT NULL UNIQUE,
  binding_sha256 char(64) NOT NULL CHECK (binding_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('provisioning','active','erasing','destroyed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_at timestamptz,
  erase_requested_at timestamptz,
  destroyed_at timestamptz
);

CREATE OR REPLACE FUNCTION production_real.guard_checkpoint_object_key_custody() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, production_real AS $$
DECLARE crypto_state text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'OBJECT_KEY_CUSTODY_DELETE_FORBIDDEN'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state <> 'provisioning' OR NEW.activated_at IS NOT NULL OR NEW.erase_requested_at IS NOT NULL OR NEW.destroyed_at IS NOT NULL THEN
      RAISE EXCEPTION 'OBJECT_KEY_CUSTODY_INSERT_INVALID';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.checkpoint_id <> OLD.checkpoint_id OR NEW.key_reference <> OLD.key_reference OR NEW.binding_sha256 <> OLD.binding_sha256 THEN
    RAISE EXCEPTION 'OBJECT_KEY_CUSTODY_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.state='provisioning' AND NEW.state='active' THEN
    SELECT state INTO crypto_state FROM production_real.checkpoint_crypto_records
      WHERE checkpoint_id=NEW.checkpoint_id AND key_reference=NEW.key_reference AND binding_sha256=NEW.binding_sha256;
    IF crypto_state <> 'active' OR NEW.activated_at IS NULL THEN RAISE EXCEPTION 'OBJECT_KEY_CUSTODY_ACTIVATION_HELD'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state='active' AND NEW.state='erasing' THEN
    IF NEW.erase_requested_at IS NULL THEN RAISE EXCEPTION 'OBJECT_KEY_CUSTODY_ERASURE_INTENT_REQUIRED'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state='erasing' AND NEW.state='destroyed' THEN
    SELECT state INTO crypto_state FROM production_real.checkpoint_crypto_records
      WHERE checkpoint_id=NEW.checkpoint_id AND key_reference=NEW.key_reference AND binding_sha256=NEW.binding_sha256;
    IF crypto_state <> 'destroyed' OR NEW.destroyed_at IS NULL THEN RAISE EXCEPTION 'OBJECT_KEY_CUSTODY_DESTRUCTION_HELD'; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'OBJECT_KEY_CUSTODY_TRANSITION_INVALID';
END $$;

DROP TRIGGER IF EXISTS checkpoint_object_key_custody_immutable ON production_real.checkpoint_object_key_custody;
CREATE TRIGGER checkpoint_object_key_custody_immutable BEFORE INSERT OR UPDATE OR DELETE ON production_real.checkpoint_object_key_custody
  FOR EACH ROW EXECUTE FUNCTION production_real.guard_checkpoint_object_key_custody();

CREATE OR REPLACE FUNCTION production_real.claim_immutable_object(
  input_key text, input_checksum char(64), input_original_operation_identity char(64), input_byte_count bigint, input_chunk_count integer,
  input_retention_until timestamptz
) RETURNS TABLE(generation bigint, checksum char(64), byte_count bigint, chunk_count integer, state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, production_real AS $$
DECLARE latest production_real.immutable_object_generations%ROWTYPE; allocated bigint; identity char(64);
BEGIN
  IF length(input_key) NOT BETWEEN 1 AND 2048 OR input_checksum !~ '^[a-f0-9]{64}$' OR input_original_operation_identity !~ '^[a-f0-9]{64}$'
     OR input_byte_count < 0 OR input_chunk_count < 0 OR NOT isfinite(input_retention_until) THEN
    RAISE EXCEPTION 'IMMUTABLE_OBJECT_INPUT_INVALID';
  END IF;
  INSERT INTO production_real.immutable_object_key_heads(object_key,next_generation) VALUES(input_key,1) ON CONFLICT(object_key) DO NOTHING;
  SELECT * INTO latest FROM production_real.immutable_object_generations
    WHERE object_key=input_key ORDER BY generation DESC LIMIT 1 FOR UPDATE;
  IF FOUND AND latest.state <> 'tombstoned' THEN
    IF latest.checksum <> input_checksum OR latest.original_operation_identity <> input_original_operation_identity OR latest.byte_count <> input_byte_count OR latest.chunk_count <> input_chunk_count THEN
      RAISE EXCEPTION 'OBJECT_IMMUTABLE_CONFLICT';
    END IF;
    RETURN QUERY SELECT latest.generation,latest.checksum,latest.byte_count,latest.chunk_count,latest.state;
    RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM production_real.immutable_object_generations WHERE object_key=input_key AND original_operation_identity=input_original_operation_identity) THEN
    RAISE EXCEPTION 'OBJECT_ORIGINAL_OPERATION_HELD';
  END IF;
  SELECT next_generation INTO allocated FROM production_real.immutable_object_key_heads WHERE object_key=input_key FOR UPDATE;
  IF allocated IS NULL OR allocated=0 THEN RAISE EXCEPTION 'OBJECT_GENERATION_EXHAUSTED'; END IF;
  UPDATE production_real.immutable_object_key_heads
    SET next_generation=CASE WHEN allocated=9007199254740991 THEN 0 ELSE allocated+1 END
    WHERE object_key=input_key;
  identity := input_original_operation_identity;
  INSERT INTO production_real.immutable_object_generations(object_key,generation,original_operation_identity,checksum,byte_count,chunk_count,retention_until,state)
    VALUES(input_key,allocated,identity,input_checksum,input_byte_count,input_chunk_count,input_retention_until,'writing');
  RETURN QUERY SELECT allocated,input_checksum,input_byte_count,input_chunk_count,'writing'::text;
END $$;

CREATE OR REPLACE FUNCTION production_real.write_immutable_object_chunk(input_key text, input_generation bigint, input_ordinal integer, input_bytes bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, production_real AS $$
DECLARE header production_real.immutable_object_generations%ROWTYPE; existing bytea;
BEGIN
  SELECT * INTO header FROM production_real.immutable_object_generations WHERE object_key=input_key AND generation=input_generation FOR UPDATE;
  IF NOT FOUND OR header.state <> 'writing' OR input_ordinal < 0 OR input_ordinal >= header.chunk_count OR octet_length(input_bytes)>393216 THEN RAISE EXCEPTION 'OBJECT_WRITE_HELD'; END IF;
  INSERT INTO production_real.immutable_object_chunks(object_key,generation,ordinal,bytes) VALUES(input_key,input_generation,input_ordinal,input_bytes) ON CONFLICT DO NOTHING;
  SELECT bytes INTO existing FROM production_real.immutable_object_chunks WHERE object_key=input_key AND generation=input_generation AND ordinal=input_ordinal;
  IF existing IS NULL OR existing <> input_bytes THEN RAISE EXCEPTION 'OBJECT_CHUNK_IDENTITY_CONFLICT'; END IF;
END $$;

CREATE OR REPLACE FUNCTION production_real.immutable_object_summary(input_key text, input_generation bigint)
RETURNS TABLE(generation bigint, checksum char(64), byte_count bigint, chunk_count integer, state text, retention_until timestamptz, stored_chunks bigint, stored_bytes bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, production_real AS $$
  SELECT h.generation,h.checksum,h.byte_count,h.chunk_count,h.state,h.retention_until,count(c.ordinal),coalesce(sum(octet_length(c.bytes)),0)
  FROM production_real.immutable_object_generations h LEFT JOIN production_real.immutable_object_chunks c ON c.object_key=h.object_key AND c.generation=h.generation
  WHERE h.object_key=input_key AND h.generation=input_generation
  GROUP BY h.object_key,h.generation,h.checksum,h.byte_count,h.chunk_count,h.state,h.retention_until
$$;

CREATE OR REPLACE FUNCTION production_real.read_immutable_object_chunk(input_key text, input_generation bigint, input_ordinal integer)
RETURNS bytea LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, production_real AS $$
DECLARE header production_real.immutable_object_generations%ROWTYPE; result bytea;
BEGIN
  SELECT * INTO header FROM production_real.immutable_object_generations WHERE object_key=input_key AND generation=input_generation;
  IF NOT FOUND OR header.state <> 'sealed' OR input_ordinal < 0 OR input_ordinal >= header.chunk_count THEN RETURN NULL; END IF;
  SELECT bytes INTO result FROM production_real.immutable_object_chunks WHERE object_key=input_key AND generation=input_generation AND ordinal=input_ordinal;
  RETURN result;
END $$;

-- The object role uses this only inside the seal verifier. ObjectStorePort
-- never exposes it, so callers cannot observe a `writing` generation.
CREATE OR REPLACE FUNCTION production_real.read_immutable_object_staged_chunk(input_key text, input_generation bigint, input_ordinal integer)
RETURNS bytea LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, production_real AS $$
DECLARE header production_real.immutable_object_generations%ROWTYPE; result bytea;
BEGIN
  SELECT * INTO header FROM production_real.immutable_object_generations WHERE object_key=input_key AND generation=input_generation;
  IF NOT FOUND OR header.state NOT IN ('writing','sealed') OR input_ordinal < 0 OR input_ordinal >= header.chunk_count THEN RETURN NULL; END IF;
  SELECT bytes INTO result FROM production_real.immutable_object_chunks WHERE object_key=input_key AND generation=input_generation AND ordinal=input_ordinal;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION production_real.seal_immutable_object(input_key text, input_generation bigint, input_checksum char(64), input_byte_count bigint, input_chunk_count integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, production_real AS $$
DECLARE header production_real.immutable_object_generations%ROWTYPE; actual_count bigint; actual_bytes bigint;
BEGIN
  SELECT * INTO header FROM production_real.immutable_object_generations WHERE object_key=input_key AND generation=input_generation FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OBJECT_EXACT_GENERATION_REQUIRED'; END IF;
  IF header.state='sealed' THEN RETURN header.checksum=input_checksum AND header.byte_count=input_byte_count AND header.chunk_count=input_chunk_count; END IF;
  IF header.state <> 'writing' OR header.checksum<>input_checksum OR header.byte_count<>input_byte_count OR header.chunk_count<>input_chunk_count THEN RAISE EXCEPTION 'OBJECT_WRITE_HELD'; END IF;
  SELECT count(*),coalesce(sum(octet_length(bytes)),0) INTO actual_count,actual_bytes FROM production_real.immutable_object_chunks WHERE object_key=input_key AND generation=input_generation;
  IF actual_count<>header.chunk_count OR actual_bytes<>header.byte_count THEN RAISE EXCEPTION 'OBJECT_PARTIAL_WRITE'; END IF;
  UPDATE production_real.immutable_object_generations SET state='sealed',sealed_at=clock_timestamp() WHERE object_key=input_key AND generation=input_generation AND state='writing';
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION production_real.observe_immutable_object(input_key text, input_checksum char(64), input_original_operation_identity char(64))
RETURNS TABLE(generation bigint, checksum char(64)) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, production_real AS $$
  SELECT generation,checksum FROM production_real.immutable_object_generations WHERE object_key=input_key AND checksum=input_checksum AND original_operation_identity=input_original_operation_identity AND state='sealed'
$$;

CREATE OR REPLACE FUNCTION production_real.observe_immutable_object(input_key text, input_checksum char(64))
RETURNS TABLE(generation bigint, checksum char(64)) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, production_real AS $$
  SELECT generation,checksum FROM production_real.immutable_object_generations
  WHERE object_key=input_key AND checksum=input_checksum AND state='sealed'
    AND 1=(SELECT count(*) FROM production_real.immutable_object_generations WHERE object_key=input_key AND checksum=input_checksum)
$$;

CREATE OR REPLACE FUNCTION production_real.claim_immutable_object_deletion(input_key text, input_generation bigint, input_checksum char(64), input_delete_after timestamptz, input_now timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, production_real AS $$
DECLARE header production_real.immutable_object_generations%ROWTYPE;
BEGIN
  SELECT * INTO header FROM production_real.immutable_object_generations WHERE object_key=input_key AND generation=input_generation FOR UPDATE;
  IF NOT FOUND OR header.checksum<>input_checksum OR NOT isfinite(input_delete_after) OR NOT isfinite(input_now) THEN RAISE EXCEPTION 'OBJECT_EXACT_GENERATION_REQUIRED'; END IF;
  IF header.state='tombstoned' THEN RETURN true; END IF;
  IF header.state<>'sealed' AND header.state<>'deleting' THEN RAISE EXCEPTION 'OBJECT_DELETE_HELD'; END IF;
  IF header.state='deleting' THEN RETURN false; END IF;
  IF input_delete_after > input_now THEN
    UPDATE production_real.immutable_object_generations SET delete_after=input_delete_after WHERE object_key=input_key AND generation=input_generation AND state='sealed';
    RETURN true;
  END IF;
  UPDATE production_real.immutable_object_generations SET state='deleting',delete_after=input_delete_after WHERE object_key=input_key AND generation=input_generation AND state='sealed';
  RETURN false;
END $$;

CREATE OR REPLACE FUNCTION production_real.delete_immutable_object_chunk_batch(input_key text, input_generation bigint, input_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, production_real AS $$
DECLARE deleted_count integer;
BEGIN
  IF input_limit NOT BETWEEN 1 AND 1024 OR NOT EXISTS(SELECT 1 FROM production_real.immutable_object_generations WHERE object_key=input_key AND generation=input_generation AND state='deleting') THEN RAISE EXCEPTION 'OBJECT_DELETE_HELD'; END IF;
  WITH picked AS (SELECT ctid FROM production_real.immutable_object_chunks WHERE object_key=input_key AND generation=input_generation ORDER BY ordinal LIMIT input_limit)
  DELETE FROM production_real.immutable_object_chunks WHERE ctid IN (SELECT ctid FROM picked);
  GET DIAGNOSTICS deleted_count = ROW_COUNT; RETURN deleted_count;
END $$;

CREATE OR REPLACE FUNCTION production_real.finish_immutable_object_deletion(input_key text, input_generation bigint, input_checksum char(64))
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, production_real AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM production_real.immutable_object_chunks WHERE object_key=input_key AND generation=input_generation) THEN RAISE EXCEPTION 'OBJECT_DELETE_PARTIAL'; END IF;
  UPDATE production_real.immutable_object_generations SET state='tombstoned',deleted_at=clock_timestamp() WHERE object_key=input_key AND generation=input_generation AND checksum=input_checksum AND state='deleting';
  IF FOUND THEN RETURN true; END IF;
  RETURN EXISTS(SELECT 1 FROM production_real.immutable_object_generations WHERE object_key=input_key AND generation=input_generation AND checksum=input_checksum AND state='tombstoned');
END $$;

REVOKE ALL ON production_real.immutable_object_key_heads,production_real.immutable_object_generations,production_real.immutable_object_chunks FROM PUBLIC,napplet_production_real,napplet_production_object;
REVOKE ALL ON production_real.checkpoint_object_key_custody FROM PUBLIC,napplet_production_real,napplet_production_object;
REVOKE ALL ON FUNCTION production_real.claim_immutable_object(text,char(64),char(64),bigint,integer,timestamptz),production_real.write_immutable_object_chunk(text,bigint,integer,bytea),production_real.immutable_object_summary(text,bigint),production_real.read_immutable_object_chunk(text,bigint,integer),production_real.read_immutable_object_staged_chunk(text,bigint,integer),production_real.seal_immutable_object(text,bigint,char(64),bigint,integer),production_real.observe_immutable_object(text,char(64)),production_real.observe_immutable_object(text,char(64),char(64)),production_real.claim_immutable_object_deletion(text,bigint,char(64),timestamptz,timestamptz),production_real.delete_immutable_object_chunk_batch(text,bigint,integer),production_real.finish_immutable_object_deletion(text,bigint,char(64)) FROM PUBLIC;
GRANT USAGE ON SCHEMA production_real TO napplet_production_object;
GRANT EXECUTE ON FUNCTION production_real.claim_immutable_object(text,char(64),char(64),bigint,integer,timestamptz),production_real.write_immutable_object_chunk(text,bigint,integer,bytea),production_real.immutable_object_summary(text,bigint),production_real.read_immutable_object_chunk(text,bigint,integer),production_real.read_immutable_object_staged_chunk(text,bigint,integer),production_real.seal_immutable_object(text,bigint,char(64),bigint,integer),production_real.observe_immutable_object(text,char(64)),production_real.observe_immutable_object(text,char(64),char(64)),production_real.claim_immutable_object_deletion(text,bigint,char(64),timestamptz,timestamptz),production_real.delete_immutable_object_chunk_batch(text,bigint,integer),production_real.finish_immutable_object_deletion(text,bigint,char(64)) TO napplet_production_object;
GRANT SELECT,INSERT ON production_real.checkpoint_object_key_custody TO napplet_production_real;
GRANT UPDATE(state,activated_at,erase_requested_at,destroyed_at) ON production_real.checkpoint_object_key_custody TO napplet_production_real;
COMMIT;
