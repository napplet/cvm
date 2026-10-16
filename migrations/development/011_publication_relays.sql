ALTER TABLE development_publications ADD COLUMN relay_results jsonb NOT NULL DEFAULT '[]'::jsonb;
