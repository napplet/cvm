-- Public signed napplet input, bound to the authenticated CVM caller.
CREATE TABLE development_remix_imports (
  reference text PRIMARY KEY,
  account_id text NOT NULL,
  event_id char(64) NOT NULL,
  artifact_hash char(64) NOT NULL,
  manifest_json jsonb NOT NULL,
  context_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, event_id)
);

CREATE TABLE IF NOT EXISTS development_remix_parts (
 account_id text NOT NULL, event_id text NOT NULL, artifact_hash text NOT NULL,
 part_index integer NOT NULL CHECK(part_index BETWEEN 0 AND 15),
 part_count integer NOT NULL CHECK(part_count BETWEEN 1 AND 16),
 data text NOT NULL CHECK(length(data) <= 10668),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,event_id,artifact_hash,part_index)
);
