BEGIN;
/* Keep historical V1 documents and quote hashes immutable.  This changes only
 * the admission constraint for subsequently inserted V2 lineage documents. */
DO $$
DECLARE prior_constraint text;
BEGIN
  SELECT c.conname INTO prior_constraint
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid='production_real.resume_pricing_quotes'::regclass
    AND c.contype='c'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%resume-pricing-quote-v1%'
  LIMIT 1;
  IF prior_constraint IS NOT NULL THEN
    EXECUTE pg_catalog.format('ALTER TABLE production_real.resume_pricing_quotes DROP CONSTRAINT %I', prior_constraint);
  END IF;
END $$;
ALTER TABLE production_real.resume_pricing_quotes ADD CONSTRAINT resume_pricing_quote_document_version CHECK (
  quote_json ?& ARRAY['schemaVersion','quoteReference','quoteSha256','preparationKey','preparedAtMs','expiresAtMs','context','pricing','maximumUsdMicros','maximumSat','priceSourcesSha256']
  AND quote_json->'context' ?& ARRAY['realm','accountId','sessionId','checkpointId','checkpointSha256','checkpointVersion','expectedSessionVersion','expectedArtifactVersion','pendingAction','commandSha256','originalOperationId','originalSettlementSha256','originalCommandMaximum','policyVersion','toolchainId','retentionUntilMs']
  AND quote_json->>'schemaVersion' IN ('resume-pricing-quote-v1','resume-pricing-quote-v2')
  AND (quote_json->>'schemaVersion'='resume-pricing-quote-v1' OR quote_json ?& ARRAY['sourceProfile','sourceCard','sourceProfileSha256','sourceCardSha256','derivedProfileSha256','derivedCardSha256'])
  AND quote_json->>'quoteReference'=quote_reference AND quote_json->>'quoteSha256'=quote_sha256
  AND quote_json->>'preparationKey'=preparation_key
  AND (quote_json->>'preparedAtMs')::bigint=prepared_at_ms AND (quote_json->>'expiresAtMs')::bigint=expires_at_ms
  AND quote_json->'context'->>'realm'='production-real'
  AND quote_json->'context'->>'accountId'=account_id AND quote_json->'context'->>'checkpointId'=checkpoint_id
);
COMMIT;
