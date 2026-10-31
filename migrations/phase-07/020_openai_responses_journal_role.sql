-- Additive least-privilege role for the native OpenAI Responses operation
-- journal.  It is intentionally separate from the core accounting role.
DO $$ BEGIN CREATE ROLE napplet_openai_responses_journal NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
REVOKE ALL ON SCHEMA production_real FROM napplet_openai_responses_journal;
GRANT USAGE ON SCHEMA production_real TO napplet_openai_responses_journal;
REVOKE ALL ON production_real.release_operation_journal, production_real.release_operation_audit FROM napplet_openai_responses_journal;
GRANT SELECT, INSERT ON production_real.release_operation_journal TO napplet_openai_responses_journal;
GRANT UPDATE(value_json, revision, updated_at) ON production_real.release_operation_journal TO napplet_openai_responses_journal;
ALTER TABLE production_real.release_operation_journal ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS openai_responses_journal_namespace ON production_real.release_operation_journal;
CREATE POLICY openai_responses_journal_namespace ON production_real.release_operation_journal
  FOR ALL TO napplet_openai_responses_journal
  USING (namespace = 'openai:responses')
  WITH CHECK (namespace = 'openai:responses');
DROP POLICY IF EXISTS production_real_core_journal_compatibility ON production_real.release_operation_journal;
CREATE POLICY production_real_core_journal_compatibility ON production_real.release_operation_journal
  FOR ALL TO napplet_production_real
  USING (true) WITH CHECK (true);
