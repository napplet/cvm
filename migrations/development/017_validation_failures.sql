-- A failed compiler validation is an immutable, bounded diagnostic projection.
-- Existing non-repairable failed rows intentionally retain NULL.
ALTER TABLE development_worker_results
  ADD COLUMN IF NOT EXISTS failure_json jsonb;
