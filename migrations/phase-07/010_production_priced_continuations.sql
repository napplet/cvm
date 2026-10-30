BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS resume_quote_owner_binding ON production_real.resume_pricing_quotes(quote_reference,account_id,checkpoint_id,quote_sha256);
CREATE TABLE IF NOT EXISTS production_real.priced_continuation_claims (
  claim_reference text PRIMARY KEY,
  account_id text NOT NULL, session_id text NOT NULL, checkpoint_id text NOT NULL,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 160),
  fingerprint_sha256 text NOT NULL CHECK(fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  quote_reference text NOT NULL UNIQUE, quote_sha256 text NOT NULL,
  action_key text NOT NULL UNIQUE, action_id text NOT NULL UNIQUE, operation_id text NOT NULL UNIQUE,
  action_budget_reference text NOT NULL UNIQUE, lease_token text NOT NULL UNIQUE, allocation_intent_reference text NOT NULL UNIQUE,
  accepted_at_ms bigint NOT NULL CHECK(accepted_at_ms BETWEEN 0 AND 9007199254740991),
  settlement_json jsonb NOT NULL CHECK(jsonb_typeof(settlement_json)='object' AND octet_length(settlement_json::text)<=16384),
  api_claimed_at_ms bigint, api_namespace text, api_scope_sha256 text, api_request_sha256 text,
  state text NOT NULL CHECK(state IN ('accepted','dispatching','superseded','completed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(account_id,idempotency_key),
  CHECK ((api_claimed_at_ms IS NULL AND api_namespace IS NULL AND api_scope_sha256 IS NULL AND api_request_sha256 IS NULL)
    OR (api_claimed_at_ms IS NOT NULL AND api_claimed_at_ms BETWEEN 0 AND 9007199254740991 AND api_namespace IS NOT NULL
      AND api_scope_sha256 IS NOT NULL AND api_request_sha256 IS NOT NULL AND api_scope_sha256 ~ '^[a-f0-9]{64}$' AND api_request_sha256 ~ '^[a-f0-9]{64}$')),
  FOREIGN KEY(checkpoint_id,account_id,session_id) REFERENCES production_real.continuation_checkpoints(checkpoint_id,account_id,session_id),
  FOREIGN KEY(quote_reference,account_id,checkpoint_id,quote_sha256) REFERENCES production_real.resume_pricing_quotes(quote_reference,account_id,checkpoint_id,quote_sha256),
  FOREIGN KEY(action_id,account_id,session_id) REFERENCES production_real.metered_actions(id,account_id,session_id),
  FOREIGN KEY(account_id,operation_id) REFERENCES production_real.provider_operations(account_id,id),
  FOREIGN KEY(action_budget_reference) REFERENCES production_real.action_budget_reservations(reservation_reference)
);
CREATE UNIQUE INDEX IF NOT EXISTS priced_continuation_one_current ON production_real.priced_continuation_claims(checkpoint_id) WHERE state IN ('accepted','dispatching');
CREATE TABLE IF NOT EXISTS production_real.priced_continuation_audit (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_reference text NOT NULL REFERENCES production_real.priced_continuation_claims(claim_reference),
  state text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION production_real.guard_priced_continuation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PRICED_CONTINUATION_IMMUTABLE'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['state','updated_at','api_claimed_at_ms','api_namespace','api_scope_sha256','api_request_sha256']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','updated_at','api_claimed_at_ms','api_namespace','api_scope_sha256','api_request_sha256'])
      OR NOT(NEW.state=OLD.state OR (OLD.state='accepted' AND NEW.state IN ('dispatching','superseded')) OR (OLD.state='dispatching' AND NEW.state IN ('completed','superseded')))
    THEN RAISE EXCEPTION 'PRICED_CONTINUATION_IMMUTABLE'; END IF;
    IF OLD.api_claimed_at_ms IS NOT NULL AND ROW(NEW.api_claimed_at_ms,NEW.api_namespace,NEW.api_scope_sha256,NEW.api_request_sha256)
      IS DISTINCT FROM ROW(OLD.api_claimed_at_ms,OLD.api_namespace,OLD.api_scope_sha256,OLD.api_request_sha256)
    THEN RAISE EXCEPTION 'PRICED_CONTINUATION_API_BINDING_IMMUTABLE'; END IF;
    IF OLD.api_claimed_at_ms IS NULL AND NEW.api_claimed_at_ms IS NOT NULL AND (NEW.state<>'dispatching' OR NOT EXISTS(
      SELECT 1 FROM production_real.release_operation_journal r WHERE r.operation_id=NEW.operation_id AND r.namespace=NEW.api_namespace
        AND r.scope_sha256=NEW.api_scope_sha256 AND r.value_json->>'requestSha256'=NEW.api_request_sha256 AND r.revision=1
    )) THEN RAISE EXCEPTION 'PRICED_CONTINUATION_API_BINDING_DENIED'; END IF;
    IF NEW.state='superseded' AND OLD.state<>NEW.state AND NOT EXISTS(
      SELECT 1 FROM production_real.provider_operations o JOIN production_real.metered_actions a ON a.id=o.action_id
      JOIN production_real.action_budget_reservations b ON b.reservation_reference=a.budget_reference
      WHERE o.id=NEW.operation_id AND o.state IN ('prepared','active') AND NEW.api_claimed_at_ms IS NULL AND a.state='failed' AND a.terminal_result IS NOT NULL AND b.state='released'
    ) THEN RAISE EXCEPTION 'PRICED_CONTINUATION_SUPERSESSION_DENIED'; END IF;
    IF NEW.state='completed' AND OLD.state<>NEW.state AND NOT EXISTS(
      SELECT 1 FROM production_real.metered_actions a JOIN production_real.action_budget_reservations b ON b.reservation_reference=a.budget_reference
      WHERE a.id=NEW.action_id AND a.terminal_result IS NOT NULL AND b.state='released' AND NEW.api_claimed_at_ms IS NOT NULL
    ) THEN RAISE EXCEPTION 'PRICED_CONTINUATION_COMPLETION_DENIED'; END IF;
    NEW.updated_at=clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.state<>'accepted' OR NEW.api_claimed_at_ms IS NOT NULL OR NOT EXISTS(
    SELECT 1 FROM production_real.resume_pricing_quotes q
    JOIN production_real.continuation_checkpoints c ON c.checkpoint_id=q.checkpoint_id AND c.account_id=q.account_id
    JOIN production_real.continuation_pauses p ON p.account_id=c.account_id AND p.session_id=c.session_id AND p.pause_generation=c.pause_generation
    JOIN production_real.metered_actions a ON a.id=NEW.action_id AND a.account_id=NEW.account_id AND a.session_id=NEW.session_id
    JOIN production_real.provider_operations o ON o.id=NEW.operation_id AND o.action_id=a.id
    JOIN production_real.action_budget_reservations b ON b.reservation_reference=NEW.action_budget_reference AND b.account_id=NEW.account_id
    WHERE q.quote_reference=NEW.quote_reference AND q.quote_sha256=NEW.quote_sha256 AND q.account_id=NEW.account_id AND q.checkpoint_id=NEW.checkpoint_id
      AND c.state='resume_required' AND p.state='resume_required' AND c.session_id=NEW.session_id
      AND NEW.accepted_at_ms>=q.prepared_at_ms AND NEW.accepted_at_ms<q.expires_at_ms
      AND q.prepared_at_ms<=extract(epoch FROM clock_timestamp())*1000 AND q.expires_at_ms>extract(epoch FROM clock_timestamp())*1000
      AND c.retention_deadline_ms=(q.quote_json->'context'->>'retentionUntilMs')::bigint
      AND p.pending_fingerprint_sha256=q.quote_json->'context'->'pendingAction'->>'fingerprint'
      AND a.idempotency_key=NEW.action_key AND a.fingerprint=NEW.fingerprint_sha256 AND a.operation_id=NEW.operation_id
      AND a.expected_session_version=(q.quote_json->'context'->>'expectedSessionVersion')::integer
      AND a.profile_id=q.quote_json->'pricing'->'profile'->>'id' AND a.price_card_id=q.quote_json->'pricing'->'card'->>'id'
      AND a.budget_reference=NEW.action_budget_reference AND a.reservation_sat=(q.quote_json->>'maximumSat')::bigint
      AND a.reservation_sat<=(q.quote_json->'context'->>'originalCommandMaximum')::numeric
      AND a.state='prepared' AND a.terminal_result IS NULL AND o.state='prepared' AND b.state='authorized' AND b.amount=a.reservation_sat
      AND NEW.settlement_json->>'accountId'=NEW.account_id AND NEW.settlement_json->>'operationId'=NEW.operation_id
      AND NEW.settlement_json->'conversion'=q.quote_json->'pricing'->'conversion'
      AND NEW.settlement_json->>'maximumUsdMicros'=q.quote_json->>'maximumUsdMicros'
      AND extract(epoch FROM (NEW.settlement_json->>'acceptedAt')::timestamptz)*1000=NEW.accepted_at_ms
      AND NOT EXISTS(SELECT 1 FROM production_real.continuation_resume_commands v1 WHERE v1.checkpoint_id=c.checkpoint_id)
      AND NOT EXISTS(SELECT 1 FROM production_real.release_operation_journal r WHERE r.operation_id=NEW.operation_id)
  ) THEN RAISE EXCEPTION 'PRICED_CONTINUATION_BINDING_DENIED'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS priced_continuation_guard ON production_real.priced_continuation_claims;
CREATE TRIGGER priced_continuation_guard BEFORE INSERT OR UPDATE OR DELETE ON production_real.priced_continuation_claims FOR EACH ROW EXECUTE FUNCTION production_real.guard_priced_continuation();
CREATE OR REPLACE FUNCTION production_real.audit_priced_continuation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.state<>OLD.state THEN
    INSERT INTO production_real.priced_continuation_audit(claim_reference,state) VALUES(NEW.claim_reference,NEW.state);
  END IF;
  IF TG_OP='UPDATE' AND OLD.api_claimed_at_ms IS NULL AND NEW.api_claimed_at_ms IS NOT NULL THEN
    INSERT INTO production_real.priced_continuation_audit(claim_reference,state) VALUES(NEW.claim_reference,'api_claimed');
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION production_real.audit_priced_continuation() FROM PUBLIC;
DROP TRIGGER IF EXISTS priced_continuation_audit ON production_real.priced_continuation_claims;
CREATE TRIGGER priced_continuation_audit AFTER INSERT OR UPDATE ON production_real.priced_continuation_claims FOR EACH ROW EXECUTE FUNCTION production_real.audit_priced_continuation();
DROP TRIGGER IF EXISTS priced_continuation_audit_immutable ON production_real.priced_continuation_audit;
CREATE TRIGGER priced_continuation_audit_immutable BEFORE UPDATE OR DELETE ON production_real.priced_continuation_audit
  FOR EACH ROW EXECUTE FUNCTION production_real.reject_phase04_append_only_change();
CREATE OR REPLACE FUNCTION production_real.fence_priced_provider_dispatch() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE claim production_real.priced_continuation_claims%ROWTYPE;
BEGIN
  IF NEW.state<>'active' OR OLD.state='active' THEN RETURN NEW; END IF;
  SELECT * INTO claim FROM production_real.priced_continuation_claims WHERE operation_id=NEW.id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF OLD.state<>'prepared' OR claim.state<>'accepted' OR NOT EXISTS(
    SELECT 1 FROM production_real.resume_pricing_quotes q
    JOIN production_real.metered_actions a ON a.id=claim.action_id AND a.account_id=claim.account_id
    JOIN production_real.action_budget_reservations b ON b.reservation_reference=claim.action_budget_reference
    JOIN production_real.session_cap_holds h ON h.account_id=a.account_id AND h.reference=a.admission_reference AND h.state='active'
    JOIN production_real.continuation_checkpoints cp ON cp.checkpoint_id=claim.checkpoint_id AND cp.account_id=claim.account_id
    JOIN production_real.continuation_pauses p ON p.account_id=cp.account_id AND p.session_id=cp.session_id AND p.pause_generation=cp.pause_generation
    WHERE q.quote_reference=claim.quote_reference AND q.quote_sha256=claim.quote_sha256
      AND q.prepared_at_ms<=extract(epoch FROM clock_timestamp())*1000 AND q.expires_at_ms>extract(epoch FROM clock_timestamp())*1000
      AND a.operation_id=NEW.id AND a.terminal_result IS NULL AND b.state='authorized' AND b.amount<=h.held_amount
      AND cp.state='claimed' AND p.state IN ('claimed','restored') AND cp.retention_deadline_ms>extract(epoch FROM clock_timestamp())*1000
  ) THEN RAISE EXCEPTION 'PRICED_CONTINUATION_DISPATCH_DENIED'; END IF;
  UPDATE production_real.priced_continuation_claims SET state='dispatching' WHERE claim_reference=claim.claim_reference;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS priced_provider_dispatch_fence ON production_real.provider_operations;
CREATE TRIGGER priced_provider_dispatch_fence BEFORE UPDATE OF state ON production_real.provider_operations FOR EACH ROW EXECUTE FUNCTION production_real.fence_priced_provider_dispatch();
CREATE OR REPLACE FUNCTION production_real.fence_priced_vertex_api_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE claim production_real.priced_continuation_claims%ROWTYPE;
BEGIN
  SELECT * INTO claim FROM production_real.priced_continuation_claims WHERE operation_id=NEW.operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF claim.state<>'dispatching' OR claim.api_claimed_at_ms IS NOT NULL OR NOT EXISTS(
    SELECT 1 FROM production_real.resume_pricing_quotes q WHERE q.quote_reference=claim.quote_reference AND q.quote_sha256=claim.quote_sha256
      AND q.prepared_at_ms<=extract(epoch FROM clock_timestamp())*1000 AND q.expires_at_ms>extract(epoch FROM clock_timestamp())*1000
      AND NEW.value_json ?& ARRAY['operationId','requestSha256','nonce','request','price','model','location','candidateSha256','projectId']
      AND NEW.value_json->>'operationId'=claim.operation_id AND NEW.value_json->>'model'=q.quote_json->'pricing'->'profile'->>'model'
      AND NEW.value_json->>'location'='global' AND NOT(NEW.value_json ? 'interactionId') AND NOT(NEW.value_json ? 'completedReceipt')
      AND NEW.value_json->'price'->>'sourceDocumentSha256'=q.quote_json->'pricing'->'card'->'sources'->'provider'->>'capturedBytesSha256'
      AND NEW.value_json->'price'->>'sourceUrl'=q.quote_json->'pricing'->'card'->'sources'->'provider'->>'url'
      AND (NEW.value_json->'price'->>'observedAtMs')::numeric<=extract(epoch FROM clock_timestamp())*1000
      AND (NEW.value_json->'price'->>'freshUntilMs')::numeric>extract(epoch FROM clock_timestamp())*1000
      AND (NEW.value_json->'price'->>'effectiveFromMs')::numeric<=extract(epoch FROM clock_timestamp())*1000
      AND (NEW.value_json->'price'->>'effectiveUntilMs')::numeric>extract(epoch FROM clock_timestamp())*1000
      AND (NEW.value_json->'price'->>'inputMicrosPerMillion')::numeric*(q.quote_json->'pricing'->'card'->'rates'->'input_tokens'->>'denominator')::numeric
        =1000000*(q.quote_json->'pricing'->'card'->'rates'->'input_tokens'->>'numerator')::numeric
      AND (NEW.value_json->'price'->>'cachedInputMicrosPerMillion')::numeric*(q.quote_json->'pricing'->'card'->'rates'->'cached_tokens'->>'denominator')::numeric
        =1000000*(q.quote_json->'pricing'->'card'->'rates'->'cached_tokens'->>'numerator')::numeric
      AND (NEW.value_json->'price'->>'outputAndThoughtMicrosPerMillion')::numeric*(q.quote_json->'pricing'->'card'->'rates'->'output_tokens'->>'denominator')::numeric
        =1000000*(q.quote_json->'pricing'->'card'->'rates'->'output_tokens'->>'numerator')::numeric
      AND (NEW.value_json->'price'->>'outputAndThoughtMicrosPerMillion')::numeric*(q.quote_json->'pricing'->'card'->'rates'->'reasoning_tokens'->>'denominator')::numeric
        =1000000*(q.quote_json->'pricing'->'card'->'rates'->'reasoning_tokens'->>'numerator')::numeric
      AND (NEW.value_json->'request'->>'maximumInputTokens')::numeric=(SELECT (u->>'units')::numeric FROM jsonb_array_elements(q.quote_json->'pricing'->'profile'->'maximumUnits') u WHERE u->>'dimension'='input_tokens')
      AND (NEW.value_json->'request'->>'maximumOutputTokens')::numeric=(SELECT sum((u->>'units')::numeric) FROM jsonb_array_elements(q.quote_json->'pricing'->'profile'->'maximumUnits') u WHERE u->>'dimension' IN ('output_tokens','reasoning_tokens'))
  ) THEN RAISE EXCEPTION 'PRICED_CONTINUATION_API_CLAIM_DENIED'; END IF;
  UPDATE production_real.priced_continuation_claims SET api_claimed_at_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint,
    api_namespace=NEW.namespace,api_scope_sha256=NEW.scope_sha256,api_request_sha256=NEW.value_json->>'requestSha256' WHERE claim_reference=claim.claim_reference;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS priced_vertex_api_claim_fence ON production_real.release_operation_journal;
CREATE TRIGGER priced_vertex_api_claim_fence AFTER INSERT ON production_real.release_operation_journal FOR EACH ROW EXECUTE FUNCTION production_real.fence_priced_vertex_api_claim();
REVOKE ALL ON production_real.priced_continuation_claims,production_real.priced_continuation_audit FROM PUBLIC,napplet_production_real;
GRANT SELECT,INSERT ON production_real.priced_continuation_claims TO napplet_production_real;
GRANT UPDATE(state,updated_at,api_claimed_at_ms,api_namespace,api_scope_sha256,api_request_sha256) ON production_real.priced_continuation_claims TO napplet_production_real;
GRANT SELECT ON production_real.priced_continuation_audit TO napplet_production_real;
COMMIT;
