-- Compatibility repair: finalization releases an action reservation and can
-- consume the last sat of its session hold. Keep positive original amounts and
-- nonnegative remaining money; do not rewrite the already-applied Phase 3 DDL.
BEGIN;
ALTER TABLE action_budget_reservations DROP CONSTRAINT action_budget_reservations_state_check;
ALTER TABLE action_budget_reservations ADD CONSTRAINT action_budget_reservations_state_check
  CHECK (state IN ('authorized', 'released'));
ALTER TABLE session_cap_holds DROP CONSTRAINT session_cap_holds_held_amount_check;
ALTER TABLE session_cap_holds ADD CONSTRAINT session_cap_holds_held_amount_check
  CHECK (held_amount >= 0);
COMMIT;
