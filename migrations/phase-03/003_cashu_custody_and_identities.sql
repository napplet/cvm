-- Repair the Cashu replay/custody schema for authorities that already applied
-- 001 before semantic proof identities were introduced.  Both public
-- development history and the isolated production realm need the same durable
-- claim fence; this migration is intentionally additive and preserves rows.

CREATE TABLE IF NOT EXISTS public.cashu_top_up_proof_identities (
  proof_identity char(64) PRIMARY KEY,
  top_up_id text NOT NULL REFERENCES public.cashu_top_up_state(top_up_id),
  account_id text NOT NULL
);
CREATE INDEX IF NOT EXISTS cashu_top_up_proof_identities_top_up_idx ON public.cashu_top_up_proof_identities(top_up_id);

DO $$
BEGIN
  IF to_regnamespace('production_real') IS NOT NULL THEN
    EXECUTE 'CREATE TABLE IF NOT EXISTS production_real.cashu_top_up_proof_identities (
      proof_identity char(64) PRIMARY KEY,
      top_up_id text NOT NULL REFERENCES production_real.cashu_top_up_state(top_up_id),
      account_id text NOT NULL REFERENCES production_real.funding_accounts(account_id)
    )';
    EXECUTE 'CREATE INDEX IF NOT EXISTS cashu_top_up_proof_identities_top_up_idx ON production_real.cashu_top_up_proof_identities(top_up_id)';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'napplet_production_real') THEN
      GRANT SELECT, INSERT ON production_real.cashu_top_up_proof_identities TO napplet_production_real;
    END IF;
  END IF;
END $$;

-- The encrypted blobs themselves live in protected_rail_material.  The journal
-- contains only vault references plus immutable swap facts, so a restart can
-- restore the exact original blinded messages without retaining plaintext.
ALTER TABLE public.cashu_top_up_state ADD COLUMN IF NOT EXISTS custody_json jsonb;
DO $$
BEGIN
  IF to_regclass('production_real.cashu_top_up_state') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE production_real.cashu_top_up_state ADD COLUMN IF NOT EXISTS custody_json jsonb';
  END IF;
END $$;
