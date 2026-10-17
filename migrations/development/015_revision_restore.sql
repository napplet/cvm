BEGIN;
CREATE TABLE development_revision_restores (
  account_id text NOT NULL REFERENCES funding_accounts(account_id),
  session_id text NOT NULL REFERENCES metered_sessions(id),
  idempotency_key text NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  result_version integer NOT NULL CHECK (result_version = expected_version + 1),
  from_version integer NOT NULL CHECK (from_version > 0),
  artifact_version integer NOT NULL CHECK (artifact_version > 0),
  artifact_id text NOT NULL REFERENCES development_artifacts(artifact_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id,idempotency_key), UNIQUE (session_id,result_version)
);
CREATE TRIGGER revision_restores_append_only BEFORE UPDATE OR DELETE ON development_revision_restores
  FOR EACH ROW EXECUTE FUNCTION reject_phase04_append_only_change();
-- Restoring and republishing an older build can make it the newest publication.
CREATE OR REPLACE VIEW development_project_listing AS
SELECT p.id,p.owner_pubkey,p.title,p.created_at,s.id AS session_id,NULL::text AS checkpoint_id,
  s.version,s.current_verified_artifact_version AS verified_version,
  CASE WHEN s.state='verified' AND b.published_version=s.current_verified_artifact_version THEN 'published'
    WHEN s.state IN ('usage_unknown','billing_invariant_failed') THEN 'unconfirmed'
    WHEN s.state IN ('needs_top_up','prepared') THEN 'pending'
    ELSE s.state END AS stage,
  b.published_version,b.id AS publication_id,b.publisher AS published_by,b.published_at,b.event_id
FROM development_projects p JOIN metered_sessions s ON s.id=p.id
JOIN funding_accounts a ON a.account_id=s.account_id AND trim(a.nostr_pubkey)=p.owner_pubkey
LEFT JOIN LATERAL (
  SELECT b.id,b.publisher,b.published_at,b.signed_event->>'id' AS event_id,(b.prepared->>'version')::integer AS published_version
  FROM development_publications b
  WHERE b.session_id=s.id AND b.account_id=s.account_id AND b.state='published'
    AND NOT coalesce((b.prepared->>'preview')::boolean,false)
  ORDER BY b.published_at DESC NULLS LAST,b.id DESC LIMIT 1
) b ON true
UNION ALL
SELECT p.checkpoint_id,p.owner_id,'Saved applet',p.created_at,NULL::text,p.checkpoint_id,0,0,
  CASE WHEN p.state='saved' AND p.expires_at_ms < extract(epoch FROM now())*1000 THEN 'expired'
    WHEN p.state='saved' THEN 'pending' WHEN p.state='bound' THEN 'unconfirmed' ELSE 'failed' END,
  NULL::integer,NULL::text,NULL::text,NULL::timestamptz,NULL::text
FROM development_pending_actions p
WHERE NOT EXISTS (SELECT 1 FROM metered_actions a WHERE a.operation_id=p.operation_id AND a.account_id=p.account_id);
COMMIT;
