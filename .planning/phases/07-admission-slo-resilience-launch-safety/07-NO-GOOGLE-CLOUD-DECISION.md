# Infrastructure direction — 2026-10-31

The user excluded Google Cloud and clarified the intended solution: **provider neutral; Ansible; homelab or VPS; simple. No enterprise infrastructure.**

Use one application and its existing interfaces. Database, storage, model API, worker, and telemetry implementations belong in adapters configured at startup. A provider exclusion is a deployment constraint, not a new application architecture.

Deploy containers on the existing homelab/Coolify service or a VPS; use Ansible for reproducible host setup where needed. Preserve the existing service identity, credentials, projects, artifacts, and audit/test-accounting history. Do not choose a new host or deploy as part of this cleanup.

The invented `non-google-v1` graph, successor authorization versions, Patroni/etcd topology, PostgreSQL-as-object-storage design, native core/edge parallel composition, and passive host-probing project are withdrawn. Their plans and handoffs are not authority for future work. Previous Google-specific stack selections are also superseded.

Keep actual product protections: prepaid balance and spend caps, exact usage accounting, test/real-money separation, encrypted checkpoints and retention, worker isolation, user-owned signing, and ContextVM public transport. State the availability of the actual deployment honestly; do not require an invented multi-region platform to run an ordinary service.

The old Google-specific production bootstrap remains disabled. Removing the detour does not certify production, migrate funds, provision infrastructure, or enable public traffic. Reuse existing ports for the remaining application wiring; do not create another provider graph, approval protocol, or orchestration framework.
