-- Display-only request text. Never used as execution or accounting authority.
ALTER TABLE metered_actions ADD COLUMN request_text text CHECK (length(request_text) <= 512);
