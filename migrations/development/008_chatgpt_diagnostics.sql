-- Keep bounded failure facts alongside the immutable dispatch observation.
-- No provider bodies, prompts, credentials, URLs, or raw exception text.
ALTER TABLE development_chatgpt_operations ADD COLUMN diagnostic_json jsonb;
