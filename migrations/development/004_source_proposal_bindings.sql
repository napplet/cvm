-- One source digest may be generated for several independent billable actions.
-- Operation identity remains the durable ownership/billing binding.
ALTER TABLE provider_observations
  DROP CONSTRAINT provider_observations_source_proposal_sha256_fkey;

ALTER TABLE source_proposals
  DROP CONSTRAINT source_proposals_pkey;

ALTER TABLE source_proposals
  ADD PRIMARY KEY (operation_id);

CREATE INDEX source_proposals_sha256_lookup
  ON source_proposals(proposal_sha256);
