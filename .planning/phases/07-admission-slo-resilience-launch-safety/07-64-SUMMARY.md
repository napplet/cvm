---
phase: 07-admission-slo-resilience-launch-safety
plan: "64"
subsystem: infra
tags: [modal, fly-machines, worker-isolation, napplet-toolchain]
requires:
  - phase: 07-58
    provides: production deployment composition
provides:
  - authenticated Modal and Fly lifecycle and bounded execution
  - original operation identity and query-only ambiguous-create reconciliation
  - root-owned offline production worker image with enforced workload restrictions
  - repeatable native image validation workflow
requirements-completed: []
status: implementation_complete
completed: 2026-10-27
---

# Plan 07-64 — Production worker transports

Implementation, local ARM64 validation, and native AMD64 CI review pass. PR #8 merged as `df0ec9e96a4b2a68fbf754a7e6dc5cd30d7b7b1b` at 2026-10-27T17:55:26Z. No provider has been selected or certified, and no protected provider effects occurred.

## Implemented

- Official Modal SDK and authenticated Fly HTTPS transports persist original intent before creation. Provider/application, image, lease, toolchain, policy, original resource identity and deadline are bound to reconciliation. Lost creation responses trigger observation of the original resource only. Modal recovery requires the exact server tag set; Fly requires immutable creation identity. Cleanup observes absence.
- Production execution always enters the trusted bootstrap. Bounded tmpfs mounts, a fresh network namespace with loopback only, UID 65532, empty capabilities, no-new-privileges, and an environment allowlist constrain generated code. Probes fail closed on missing quota, route, filesystem, identity, or denial facts.
- Production policy allows ten minutes of active work and ten minutes of live idle grace, with a twenty-minute provider ceiling. The immutable root supervisor cannot be stopped by the workload and exits on its monotonic deadline. Legacy Phase 2 policy remains unchanged.
- Real pinned Node, Bun, pnpm, CLI, skills, boilerplate, Linux browser dependencies and Chromium execute offline scaffold/init/skills/install/build/verify/conformance/deployment-dry-run. Per-command bounded audit records survive in the validation report.
- The locked 1,000-accepted-request schedule retains both forced 200-request cohorts inside the total. Provider selection still requires the actual protected schedule and statistical gate.
- Native AMD64 CI builds the production image and runs the same resource-bounded local validation, including deadline enforcement, SIGSTOP denial and observed cleanup.

## Verification

- Denied-effects release and Modal probe suite: **208 passed, 0 failed, 1,058 assertions** (`/tmp/cvm-worker-review-release-tests.log`).
- Full local ARM64 production image run finished **2026-10-27T17:39:39.579Z**, report `/tmp/cvm-plan64-worker-final.json`, paired `.log`.
- Image ID: `sha256:bb733a42220ad2123f824c0d87d3dcfef2e08c74a45c7d6e748a31bca8a01d35`.
- Enforced local resources: **1 CPU, 1 GiB memory, no additional swap**. The outer Docker network was ordinary bridge networking; the inner bootstrap enforced network denial.
- All eight actual tooling commands succeeded. Upstream guidance: **6 passed**. Real Chromium: **5 passed, 0 failed, 5 skipped**. Skips were three unresolved-manifest checks, no emitted wire envelope, and unmeasured lifecycle. These are compatibility evidence, not complete publication/conformance certification.
- Root supervisor exited normally at its short test deadline; workload SIGSTOP failed with EPERM. All three exact validation containers were removed and observed absent.
- Local validation uses elevated bootstrap capabilities to exercise Linux mechanisms. It is explicitly marked `localMechanism: true, realProviderEvidence: false` and does not establish Modal/Fly eligibility.

## Important fixes found by running the image

The original registry boilerplate lacked the required lockfile; the image now uses the checksum-pinned official source archive. Its actual compatibility set uses pnpm 10.8.0, SDK 0.24.4, Vite plugin 0.11.2 and conformance CLI 0.2.15. Global tooling has a different conformance browser requirement, so both pinned browser revisions are present. Bun's Node alias could not run upstream guidance tests; real pinned Node and Linux browser libraries fixed the actual flow. The source surface is `src/main.ts`, and skills are installed with their real CLI. The test retains the upstream single-quoted domain-helper import requirement rather than weakening guidance.

The historical CLI asset changed upstream. Historical candidate JSON remains immutable; a separately recorded unpromoted intake pins the current official asset. Source-to-binary provenance and compatibility promotion remain Plan 67 work.

## Commits and follow-on gates

Implementation history includes `870a5be`, `d6f70dc`, `a86b022`, `f2a7357`, `ab841c3`, `68a1c13`, `1b34f77`, `b6f270c`, `9839c58`, `0c155bc`, `9bc0d25`, `71a5d8a`, `84904be`, `e92df9a`, `de93462`, `0e14de0`, and `877c571`. PR: https://github.com/napplet/cvm/pull/8.

Plan 69 must install the shared cross-region SQL journal. Plan 70 must use these production execution paths and preserve durable job/artifact identity across bounded provider exec calls. Plans 67/68/73 and protected execution must supply provenance, real provider capability probes, candidate-bound admission, conformance and publication evidence. SESS-02 and OPS-01–OPS-04 remain unverified. No live deployment or real-money effects occurred.

## Final CI review

Native AMD64 [worker run 40554580553](https://github.com/napplet/cvm/actions/runs/40554580553) and [documentation run 40554580520](https://github.com/napplet/cvm/actions/runs/40554580520) passed at reviewed head `b01c5d3bdbb148e7cda9fa6a656b524d3b1db32b`. AMD64 image ID was `sha256:dd437c19f2a2b35e942e09db6d93f5c5bf083d28c6bfd3cdd92e8c8511de7a9c`. All eight tooling commands, supervisor EPERM/deadline and all three cleanup observations passed; Chromium remained 5/0/5. Downloaded report: `/tmp/cvm-worker-ci-40554580553/production-worker-report.json`.

Initial native CI exposed Docker host mount denial. The mechanism harness now explicitly uses `apparmor=unconfined` so its trusted bootstrap can mount quotas; workload restrictions remain verified. This test configuration is not a certified provider boundary. Local ARM64 revalidation with the same option passed at `/tmp/cvm-plan64-worker-apparmor.json`.

Final review removed an unconditional Fly pending result after a valid lease-bound probe and added server-held request-digest checks to ambiguous-create recovery. Missing or mismatched observations remain unknown, and no retry creates another resource.
