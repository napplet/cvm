---
status: complete
---
# Infrastructure cleanup

The exclusion of Google Cloud was incorrectly expanded into a new architecture. Commit `fc6cefa` recommended a disjoint non-google-v1 graph and a three-host Patroni/etcd plus PostgreSQL-object-store topology. Follow-up plans created successor authorization schemas, native certification compositions and a passive host-probing framework. This was not the requested provider-neutral deployment.

The user's correction is: simple Ansible/container deployment to homelab or a VPS, reusing the existing application and configuring adapters through its current ports.

Removed the replacement graph, successor request/receipt/configuration schemas, bespoke PostgreSQL object storage and custody candidate, replacement model/cost project, and homelab passive-preflight framework. Removed 81 detour planning/handoff files from the private checkout, retired the associated unfinished execution instructions, and replaced active stack/state guidance. Preserved the existing private service, original data/credentials, billing recovery and Google-deployment refusal. The unrelated Napshot changes remain byte-identical.

Validation: 58 CVM regression/recovery tests (359 assertions), full TypeScript 5.9.3 compilation, 8 homelab production-command tests, Python compilation, shell syntax, and whitespace checks passed. Tests used fixture-only/no-external-effect mode. No infrastructure was provisioned or deployed.

History scope: replace CVM main's four detour commits after aad75d4 with one concise cleanup commit. Rebuild homelab master's detour after 6c5411b, keeping Napshot as a separate commit. Condense the private checkout's detour commits as well. Push default branches only with exact old-head leases. Close the rejected draft PR112 and retire only its related branches/worktrees.

Original remote heads: CVM fdc9405e7f10f69e8c2c6c3dd0b5ec524964765c; homelab fb3b48308fdc3d39e6d0ef4f900984cc18946273. Local recovery bundles, original refs, working-file backups, and archives of 17 retired worktrees are under /Users/sandwich/.local/state/cvm-cleanup-20261031. Exact new heads and push results are recorded there separately.

The cleanup is complete when the guarded pushes and retirement checks succeed. Production real-money wiring remains unfinished; this task does not deliver or certify a new production deployment.
