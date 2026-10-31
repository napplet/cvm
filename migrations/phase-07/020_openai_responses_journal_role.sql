-- Additive least-privilege role for the native OpenAI Responses operation
-- journal.  It is intentionally separate from the core accounting role.
DO $$ BEGIN CREATE ROLE napplet_openai_responses_journal NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
REVOKE ALL ON SCHEMA production_real FROM napplet_openai_responses_journal;
GRANT USAGE ON SCHEMA production_real TO napplet_openai_responses_journal;
REVOKE ALL ON production_real.release_operation_journal, production_real.release_operation_audit FROM napplet_openai_responses_journal;
GRANT SELECT, INSERT ON production_real.release_operation_journal TO napplet_openai_responses_journal;
GRANT UPDATE(value_json, revision, updated_at) ON production_real.release_operation_journal TO napplet_openai_responses_journal;
GRANT SELECT ON production_real.release_operation_audit TO napplet_openai_responses_journal;
