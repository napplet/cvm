BEGIN;
CREATE TABLE IF NOT EXISTS production_real.priced_continuation_finalizations (
  claim_reference text PRIMARY KEY, account_id text NOT NULL,
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  receipt_charge_sat bigint NOT NULL CHECK(receipt_charge_sat>=0),
  provider_receipt_reference text NOT NULL CHECK(length(provider_receipt_reference) BETWEEN 1 AND 256),
  normalized_receipt_json jsonb NOT NULL CHECK(jsonb_typeof(normalized_receipt_json)='object' AND octet_length(normalized_receipt_json::text)<=16384),
  settlement_json jsonb NOT NULL CHECK(jsonb_typeof(settlement_json)='object' AND octet_length(settlement_json::text)<=16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(claim_reference,account_id) REFERENCES production_real.priced_continuation_claims(claim_reference,account_id)
);
CREATE OR REPLACE FUNCTION production_real.guard_priced_finalization() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM production_real.priced_continuation_claims c
    JOIN production_real.resume_pricing_quotes q ON q.quote_reference=c.quote_reference
    JOIN production_real.priced_continuation_restores r ON r.claim_reference=c.claim_reference AND r.account_id=c.account_id
    JOIN production_real.metered_actions a ON a.id=c.action_id AND a.account_id=c.account_id
    JOIN production_real.action_budget_reservations b ON b.reservation_reference=c.action_budget_reference AND b.account_id=c.account_id
    JOIN production_real.usage_receipts u ON u.operation_id=c.operation_id AND u.account_id=c.account_id AND u.action_id=c.action_id
    JOIN production_real.continuation_checkpoints cp ON cp.checkpoint_id=c.checkpoint_id AND cp.account_id=c.account_id
    JOIN production_real.continuation_pauses p ON p.account_id=c.account_id AND p.session_id=c.session_id AND p.pause_generation=cp.pause_generation
    WHERE c.claim_reference=NEW.claim_reference AND c.account_id=NEW.account_id AND c.state='dispatching' AND c.api_claimed_at_ms IS NOT NULL
      AND r.state='restored' AND r.metadata_json->>'leaseToken'=c.lease_token AND r.metadata_json->>'resumeClaim'=c.allocation_intent_reference
      AND cp.state='claimed' AND p.state='restored' AND b.state='released' AND a.terminal_result IS NOT NULL
      AND a.state IN ('verified','failed') AND a.receipt_charge=NEW.receipt_charge_sat
      AND a.provider_receipt_reference=NEW.provider_receipt_reference AND u.protected_evidence_reference=NEW.provider_receipt_reference
      AND NEW.settlement_json=c.settlement_json
      AND (NEW.normalized_receipt_json->>'operationId'=c.operation_id AND NEW.normalized_receipt_json->>'providerRequestId'=c.operation_id
        AND NEW.normalized_receipt_json->>'profileId'=a.profile_id AND NEW.normalized_receipt_json->>'priceCardId'=a.price_card_id
        AND NEW.normalized_receipt_json->>'provider'=q.quote_json->'pricing'->'profile'->>'provider'
        AND NEW.normalized_receipt_json->>'model'=q.quote_json->'pricing'->'profile'->>'model'
        AND NEW.normalized_receipt_json->'provenance'->>'protectedEvidenceDigest'=c.api_request_sha256) IS TRUE
      AND NEW.receipt_charge_sat<=(q.quote_json->>'maximumSat')::bigint
      AND ((a.state='failed' AND a.session_version=(q.quote_json->'context'->>'expectedSessionVersion')::integer
        AND a.artifact_version=(q.quote_json->'context'->>'expectedArtifactVersion')::integer)
        OR (a.state='verified' AND a.session_version=(q.quote_json->'context'->>'expectedSessionVersion')::integer+1
          AND a.artifact_version=a.session_version AND EXISTS(SELECT 1 FROM production_real.session_artifacts x
            WHERE x.id=a.artifact_id AND x.account_id=c.account_id AND x.session_id=c.session_id AND x.action_id=c.action_id AND x.verified)))
      AND (NEW.receipt_charge_sat=0 OR EXISTS(SELECT 1 FROM production_real.ledger_transactions t
        JOIN production_real.ledger_entries e ON e.transaction_id=t.transaction_id AND e.account_id=c.account_id AND e.direction='debit'
        WHERE t.reference=c.operation_id AND e.amount=NEW.receipt_charge_sat)))
  THEN RAISE EXCEPTION 'PRICED_FINALIZATION_BINDING_DENIED'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS priced_finalization_guard ON production_real.priced_continuation_finalizations;
CREATE TRIGGER priced_finalization_guard BEFORE INSERT ON production_real.priced_continuation_finalizations
  FOR EACH ROW EXECUTE FUNCTION production_real.guard_priced_finalization();
DROP TRIGGER IF EXISTS priced_finalization_immutable ON production_real.priced_continuation_finalizations;
CREATE TRIGGER priced_finalization_immutable BEFORE UPDATE OR DELETE ON production_real.priced_continuation_finalizations
  FOR EACH ROW EXECUTE FUNCTION production_real.reject_phase04_append_only_change();
REVOKE ALL ON production_real.priced_continuation_finalizations FROM PUBLIC,napplet_production_real;
GRANT SELECT,INSERT ON production_real.priced_continuation_finalizations TO napplet_production_real;
COMMIT;
