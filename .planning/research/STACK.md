# Stack

TypeScript and Bun; transactional PostgreSQL; ContextVM/Nostr; existing model, worker, storage and telemetry adapters; pinned napplet tooling.

Deploy containers through the existing Coolify lifecycle on the homelab, or Ansible on a VPS. Provider selection belongs in configuration and concrete adapters. Google Cloud is excluded. No replacement cluster or parallel provider framework is selected or required.

See [deployment](../../docs/architecture/provider-neutral-deployment.md) for the current direction. Earlier provider-specific recommendations are historical, not active requirements.
