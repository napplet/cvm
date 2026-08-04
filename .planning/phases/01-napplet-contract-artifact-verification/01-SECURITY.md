---
phase: 01
slug: napplet-contract-artifact-verification
status: verified
threats_open: 0
asvs_level: 1
blocking_threshold: high
created: 2026-08-04
---

# Phase 01 — Security

> ASVS L1 verification of the plan-authored STRIDE register. Production certification remains a Phase 7 concern; Phase 1 verifies its design-stage fail-closed boundaries.

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Candidate record → image intake | Only the approved coherent release set may materialize into the sealed image. | Package versions, integrities, CLI checksum, lock and policy identities |
| Host → sealed toolchain | All package, fixture, build, and probe execution uses the bounded Docker adapter. | Literal argv, scrubbed environment, bounded output and status evidence |
| Generated source → shell-mediated runtime | Napplet code may use only focused, declared public capability paths. | Fixture source, capability declarations and runtime observations |
| Native reports → CVM policy/evidence | Upstream results are immutable inputs; CVM owns only inventoried policy gaps. | Report digests, artifact identities, aggregate hash and blocking verdicts |

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Evidence | Status |
|-----------|----------|-----------|----------|-------------|---------------------|--------|
| T-01-01 | Tampering | Candidate/package identity | high | mitigate | Strict pin parsing and canonical IDs in `src/promotion/schema.ts` and `src/promotion/candidate.ts`; image-input cross-checks in `scripts/build-toolchain-image.ts`. | closed |
| T-01-02 | Information disclosure / tampering | Hermetic command execution | high | mitigate | Absolute allowlist, literal argv, scrubbed child environment, bounded capture and timeout in `src/runner/hermetic-command.ts`. | closed |
| T-01-04 | Tampering / repudiation | Evidence bundle | high | mitigate | Canonical content hashes, required report references and collision-safe immutable writes in `src/evidence/bundle.ts`. | closed |
| T-01-SC | Tampering | Package intake | high | mitigate | Read-only candidate workflow; sealed frozen `--ignore-scripts` package intake; no install or promotion authority. | closed |
| T-01-06 | Denial of service | Sealed subprocess/container | medium | mitigate | CPU, memory, pids, timeout, tmpfs and output ceilings in `src/runner/sealed-toolchain.ts`. | closed |
| T-01-07 | Repudiation | Candidate evidence | medium | mitigate | Canonical candidate and evidence SHA-256 identities in `src/promotion/candidate.ts`. | closed |
| T-01-15 | Elevation of privilege | Candidate CI | high | mitigate | Read-only workflow permissions and tests rejecting install, pointer, golden and promotion authority. | closed |
| T-01-08 | Availability / provenance | Broken upstream candidate | low | accept | Broken candidates remain explicitly quarantined and cannot create a promoted/current pointer. | closed |
| T-01-10 | Elevation of privilege | Promotion path | high | mitigate | `runPromotionCandidate` delegates stages only to `runSealedToolchain`; hermetic assertion is green. | closed |
| T-01-21 | Tampering | Release-set intake | high | mitigate | Candidate ID, CLI checksum, package integrities, policy ID and lock are cross-bound; mixed/stale candidates are rejected. | closed |
| T-01-22 | Information disclosure / elevation of privilege | Fixture runner | high | mitigate | `runFixture` uses the sealed adapter with `--network=none`, read-only root, non-root UID, dropped capabilities and denial probes. | closed |
| T-01-23 | Tampering / repudiation | Native reports and artifact result | high | mitigate | Ordered stages, non-empty SHA-256 reports, candidate/image binding and aggregate identity are required by `src/fixtures/registry.ts`. | closed |
| T-01-24 | Denial of service | Build and Chromium stages | medium | mitigate | Native stages inherit sealed cgroup, time and output limits; timeouts and overflow are blocking results. | closed |
| T-01-25 | Elevation of privilege | Capability harness | high | mitigate | Only the sanctioned optional `window.napplet?.intent` presence observation is direct; use proceeds through public `requireDomain`. | closed |
| T-01-26 | Tampering | Upstream/CVM check ownership | high | mitigate | Versioned exactly-one-owner inventory and immutable fail-closed upstream verdict handling in `src/policy/artifact-contract.ts`. | closed |
| T-01-27 | Elevation of privilege | Artifact scope and authority policy | high | mitigate | Focused scope, backend, service-worker, signer/relay, dynamic authority, malformed report and capability checks block deterministically. | closed |
| T-01-28 | Tampering / repudiation | Design evidence | high | mitigate | Candidate/image/policy/fixture digests are canonicalized; waivers and false passed gates are rejected in `src/verification/design-evidence.ts`. | closed |
| T-01-29 | Information disclosure | Evidence payload | medium | mitigate | Evidence stores scrubbed identifiers and digests, not secrets or raw native output; sealed environment is minimal. | closed |
| T-01-30 | Denial of service | Policy and fixture set | medium | mitigate | Fixed representative inputs, immutable isolated results and the sealed timeout/resource boundary bound execution. | closed |

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-01 | T-01-08 | Upstream defects are quarantined and repaired upstream; Phase 1 never promotes a broken candidate. | Project decisions D-02, D-17 and D-18 | 2026-08-04 |

## Deferred Launch Hardening

The native scaffold/Chromium result remains explicitly `blocked`. Self-contained scaffold closure, exhaustive provenance and reproducibility, full hostile coverage, goldens, waiver drills, SBOM enforcement and production promotion remain Phase 7 work and are not represented as passed.

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-04 | 19 | 19 | 0 | gsd-security-auditor |

## Sign-Off

- [x] All threats have a disposition.
- [x] Accepted risks are documented.
- [x] `threats_open: 0` confirmed at the `high` blocking threshold.
- [x] `status: verified` set.

**Approval:** verified 2026-08-04
