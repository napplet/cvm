# Quick 261101-pnd: provider-neutral service and Ansible deployment

Goal: the normal production entrypoint boots one ordinary service composition from
mounted configuration, deploys with a small Ansible playbook to a homelab host or
VPS, and is verified through the real ContextVM flow, restart and backup restore.

Checklist
1. Service config + secret mount loader; realm marker prevents test DB from serving real money.
2. Funding composition from existing coordinators (NWC receiver + Cashu mints), no loopback lock in real realm.
3. Canonical migration list + separate `scripts/migrate.ts` (not run at startup).
4. Service composition reusing the existing classes (OpenAI Responses gateway, Docker worker,
   filesystem artifacts, encrypted pending checkpoints, Paja preview, user-signed publication).
   `scripts/production.ts` boots it. No Google dependency or certification machinery at startup.
5. Container image + compose; prove boot with mounted config.
6. Worker controls probed against the actual engine/runtime.
7. End-to-end flow through the same composition (signed ContextVM → top-up → generation → preview → resume → publication).
8. Ansible playbook (homelab repo), truthful `./homelab cvm production` commands, backup integration and isolated restore.
9. Docs replacing stale Google instructions.

Out of scope: Google, clusters, multi-region, new provider graph, certification orchestration.
