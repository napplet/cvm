-- One model response can be confirmed before a tool continuation exists. Keep
-- those receipts append-only so a lost continuation is never replayed as a new
-- paid request.
CREATE TABLE development_model_turn_evidence (
  operation_id text NOT NULL,
  turn_index integer NOT NULL CHECK (turn_index >= 0 AND turn_index < 3),
  intent_sha256 text NOT NULL,
  provider_response_id text NOT NULL,
  receipt_json jsonb NOT NULL,
  PRIMARY KEY(operation_id, turn_index),
  UNIQUE(provider_response_id)
);
CREATE TRIGGER development_model_turn_evidence_append_only BEFORE UPDATE OR DELETE
ON development_model_turn_evidence FOR EACH ROW EXECUTE FUNCTION reject_phase04_append_only_change();
