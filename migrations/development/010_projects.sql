BEGIN;
-- One registry entry is created in the same transaction as its metered session.
-- Ownership comes from the authenticated funding account, never request JSON.
CREATE TABLE development_projects (
  id text PRIMARY KEY REFERENCES metered_sessions(id),
  owner_pubkey text NOT NULL CHECK (owner_pubkey ~ '^[a-f0-9]{64}$'),
  title text NOT NULL DEFAULT 'Untitled applet' CHECK (length(title) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX development_projects_owner ON development_projects(owner_pubkey, created_at DESC, id DESC);
INSERT INTO development_projects(id,owner_pubkey,created_at)
SELECT s.id,trim(a.nostr_pubkey),coalesce((SELECT min(m.created_at) FROM metered_actions m WHERE m.session_id=s.id),a.created_at)
FROM metered_sessions s JOIN funding_accounts a ON a.account_id=s.account_id
WHERE a.nostr_pubkey IS NOT NULL;
CREATE FUNCTION register_development_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO development_projects(id,owner_pubkey)
  SELECT NEW.id,trim(nostr_pubkey) FROM funding_accounts WHERE account_id=NEW.account_id AND nostr_pubkey IS NOT NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER register_development_project AFTER INSERT ON metered_sessions FOR EACH ROW EXECUTE FUNCTION register_development_project();
CREATE INDEX development_pending_owner_created ON development_pending_actions(owner_id,created_at DESC,checkpoint_id DESC);

-- Stages are read from durable authorities, not a second mutable state machine.
CREATE VIEW development_project_listing AS
SELECT p.id,p.owner_pubkey,p.title,p.created_at,s.id AS session_id,NULL::text AS checkpoint_id,
  s.version, s.current_verified_artifact_version AS verified_version,
  CASE WHEN s.state='verified' AND EXISTS (
    SELECT 1 FROM development_publications b JOIN development_artifacts a ON a.artifact_id=b.artifact_id
    WHERE b.session_id=s.id AND b.account_id=s.account_id AND b.publisher=p.owner_pubkey
      AND b.state='published' AND a.version=s.current_verified_artifact_version AND NOT coalesce((b.prepared->>'preview')::boolean,false)
  ) THEN 'published'
    WHEN s.state IN ('usage_unknown','billing_invariant_failed') THEN 'unconfirmed'
    WHEN s.state='needs_top_up' THEN 'pending'
    WHEN s.state='prepared' THEN 'pending'
    ELSE s.state END AS stage
FROM development_projects p JOIN metered_sessions s ON s.id=p.id
JOIN funding_accounts a ON a.account_id=s.account_id AND trim(a.nostr_pubkey)=p.owner_pubkey
UNION ALL
SELECT p.checkpoint_id,p.owner_id,'Saved applet',p.created_at,NULL::text,p.checkpoint_id,0,0,
  CASE WHEN p.state='saved' AND p.expires_at_ms < extract(epoch FROM now())*1000 THEN 'expired'
    WHEN p.state='saved' THEN 'pending' WHEN p.state='bound' THEN 'unconfirmed' ELSE 'failed' END
FROM development_pending_actions p
WHERE NOT EXISTS (SELECT 1 FROM metered_actions a WHERE a.operation_id=p.operation_id AND a.account_id=p.account_id);
COMMIT;
