# Deployment

Run the CVM as a containerized service on the homelab or a VPS. Reuse Coolify on the existing homelab. Use Ansible when host setup/deployment needs automation. Google Cloud is excluded.

The application has one architecture. Configure concrete adapters at startup:

| Concern | Existing boundary |
| --- | --- |
| Transactional accounts and sessions | `PostgresSqlPool` / `PostgresSqlFundingStore` |
| Checkpoints and artifacts | `ObjectStorePort` / `VersionedObjectClientPort` |
| Metered model calls | `ModelGateway` |
| Isolated execution | Existing worker ports and adapters |
| Metrics and traces | `LifecycleTelemetryPort` and OTLP |
| Deployment | Container configuration and Ansible or existing Coolify lifecycle |

Keep provider credentials in adapter/bootstrap code and secret mounts, outside the domain core and generated applets. Choosing a provider changes configuration and its adapter, not funding, sessions, publication, or authorization protocols.

Start with the existing service and ordinary PostgreSQL, storage, backups, and private administration. Do not add a cluster, a custom object database, a second provider graph, or a certification orchestration system to replace Google Cloud.

Preserve data and service identity during deployment. Test balances remain test balances; production money still requires exact metering, funded caps and safe recovery. Generated code still requires enforced isolation. Checkpoint encryption/retention and user-owned signing remain product behavior.

Current state: the existing private homelab service works with development/test credits. The older production bootstrap is Google-specific and disabled. Provider-neutral application wiring for real-money operation remains unfinished; this cleanup does not claim it is deployed or verified.
