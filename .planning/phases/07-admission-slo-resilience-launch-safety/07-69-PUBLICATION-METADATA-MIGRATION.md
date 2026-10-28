# Approved CLI publication metadata

Current writers are ProductionWorkerJobClient and the source-plan materializer;
readers include the image supervisor, artifact verifier, checkpoint exporter /
restore reader, and publication context. The old request has no publication
metadata, so its CLI manifest cannot locate the approved Blossom server.

Expand the version-1 request with an optional, closed `publication.server`
HTTPS origin. Only controller construction supplies it, never generated source
or a WorkerRunRequest from the agent. Include it in new job identities and source
plan bindings. Run the pinned CLI's `init --server`; never patch its manifest.
Require the actual CLI server tag and dry-run server list to match retained
request facts before accepting new artifact output.

New readers continue accepting original requests/checkpoints without this field,
and observe their original job identities without rewriting them. A new server
cannot mutate/restart an existing action. Current production publication requires
the new approved metadata and refuses an old artifact without it.

Roll out compatible readers and the newly verified image before enabling new
writers. An old image must reject the expanded request rather than ignore it.
Before rollback, quiesce/checkpoint active work and retain compatible readers for
new archives, or restore the verified pre-cutover backup. Never reinterpret or
delete new archives to make an old strict reader accept them. No live rollout,
data migration, contraction or cleanup is part of this implementation step.
