-- Preserve all existing amounts, denominations and payment references.
-- Credit-source identifiers now belong to installed operator adapters.
ALTER TABLE top_ups DROP CONSTRAINT top_ups_rail_check;
ALTER TABLE top_ups ADD CONSTRAINT top_ups_rail_check
  CHECK (rail ~ '^[a-z][a-z0-9._-]{0,95}$');
