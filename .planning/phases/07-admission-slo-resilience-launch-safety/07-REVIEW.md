---
phase: 07-admission-slo-resilience-launch-safety
reviewed: 2026-08-05T22:37:29Z
depth: deep
files_reviewed: 21
files_reviewed_list:
  - package.json
  - scripts/verify-phase-07-otel-packages.ts
  - scripts/verify-phase-07-release.ts
  - scripts/verify-phase-07-reproducibility.ts
  - src/certification/contracts.ts
  - src/certification/evidence.ts
  - src/certification/phase-07-reference-set.ts
  - src/certification/reproducibility.ts
  - src/certification/supply-chain.ts
  - src/certification/trust.ts
  - src/promotion/candidate.ts
  - src/promotion/run-promotion.ts
  - src/promotion/schema.ts
  - tests/phase-07/certification-runner.test.ts
  - tests/phase-07/otel-package-legitimacy.test.ts
  - tests/phase-07/promotion-gate.test.ts
  - tests/phase-07/reproducibility.test.ts
  - tests/phase-07/supply-chain.test.ts
  - evidence/certification/phase-07-otel-package-approval.json
  - evidence/certification/otel-package-approvals/09594baf4025de3081ec59005b529d2e031c06c38523b8c086efd97dd6e6cc7c.json
  - evidence/certification/otel-package-smokes/23991864857cc45d6557e96907a9af75084b7b29d49023fb50a8fe8d44849919.json
findings:
  critical: 0
  warning: 0
  info: 0
  total: 0
status: clean
fixed_at: 2026-08-05T22:37:29Z
---

# Phase 07: Code Review Report

**Reviewed:** 2026-08-05T22:37:29Z
**Depth:** deep
**Files Reviewed:** 21
**Status:** clean

## Summary

All prior findings are fixed. The evaluator now compares the supplied source measurement with the canonical manifest-derived revision and digest before invoking the trust root, computing a cache key, or calling the inner evaluator. The two-archive substitution regression proves that archive B cannot authorize manifest A even when the root pins both archives; the root's existing byte-hash check rejects manifest A when its archive is mutated or absent. No additional correctness, security, or robustness defect was found in the reviewed scope.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-05: Direct promotion can authenticate a different trusted archive than the release manifest — fixed

**File:** `/Users/sandwich/Develop/napplet-cvm/src/promotion/run-promotion.ts:149`
**Issue:** `evaluateReleaseCertification` accepts caller-provided `sourceMeasurement` as `unknown` and only asks the root whether that object is a recognized measurement. It never checks `sourceMeasurement.sourceRevision` or `.sourceSha256` against `manifest.sourceRevision` / `.sourceSha256`; `evaluateReleaseCertificationInner` receives no measurement to do so either. A root with more than one pinned archive can therefore accept measurement B while it separately authenticates manifest A, A's observations, and A's verification records. A direct caller of this exported sole evaluator can then promote A even after A's archive has drifted or disappeared, provided B remains valid. The new cache fingerprint distinguishes A+B from A+A, but it does not make B manifest-bound.

**Fix:** Do not accept this fact from a caller. Construct it inside `evaluateReleaseCertification` with `releaseSourceMeasurement(manifest)` and remove `sourceMeasurement` from the public input; alternatively, strictly parse it and reject unless both values exactly equal the manifest before calling `verifySourceMeasurement`:

```ts
const expected = releaseSourceMeasurement(manifest);
if (canonicalJson(input.sourceMeasurement) !== canonicalJson(expected)) {
  return blocked("RELEASE_SOURCE_MEASUREMENT_INVALID");
}
```

Add a regression with two valid root-pinned archives: use manifest A with measurement B and assert blocking before cache/evaluator reuse, then mutate/remove archive A and assert that it still blocks.

**Resolved:** `2806dd5` compares the supplied measurement to `releaseSourceMeasurement(manifest)` before any root call or cache lookup. The new two-archive regression confirms that an otherwise trusted B measurement does not call the root for manifest A, including after archive A is mutated or removed.

### CR-01: A self-authenticated release bundle can manufacture a promoted decision — fixed

**File:** `/Users/sandwich/Develop/napplet-cvm/src/promotion/candidate.ts:275`
**Issue:** `verifyReleaseCertificationInput` accepts the release manifest, every protected-observation pointer, and both verification records from the submitted bundle. `evaluateReleaseCertification` then accepts records after checking only SHA-256 values calculated from their own public contents (`src/certification/reproducibility.ts:70-79`, `src/certification/supply-chain.ts:112-123`) and accepts observations after the same self-hash check (`src/certification/evidence.ts:20-26`). A SHA-256 is an integrity identifier, not an authenticator: an attacker can construct a manifest containing their selected policy, 17 passed observations, and both records, calculate each digest, and obtain `status: "promoted"` without a protected build or Cosign verification. The existing success fixture explicitly constructs the two "protected" records from public constants (`tests/phase-07/promotion-gate.test.ts:74-91`) and promotes the bundle (`tests/phase-07/promotion-gate.test.ts:173-214`), demonstrating the missing authority boundary.

**Fix:** Make the release manifest and protected evidence originate from an independent trust root. For example, load an allowlisted manifest digest/signature from an operator-controlled store, and require each protected observation and verification record to carry a signature or authenticated, write-only storage receipt issued by the protected certifier. Verify that authority (including key/identity rotation and storage generation) before accepting its content hash; never accept the policy or its attestation solely from the candidate bundle.

### CR-02: The claimed source SHA-256 is never computed from source bytes — fixed

**File:** `/Users/sandwich/Develop/napplet-cvm/src/certification/reproducibility.ts:51`
**Issue:** The new check compares `ProtectedBuildObservation.sourceSha256` with `releaseBinding.sourceSha256`, but both are caller-provided strings. `ProtectedBuildObservationSchema` contains no source archive, immutable source reference, or measured source-byte digest (`src/certification/reproducibility.ts:11-21`), and the protected runner similarly only compares the candidate's declared digest (`src/certification/runner.ts:53-56`). A build of modified bytes can assert the expected 64-character digest and pass all source checks. This is exact string equality, not the required exact SHA-256-of-source-bytes semantics.

**Fix:** In the protected build environment, obtain the release's immutable source archive/tree through a trusted reference, compute SHA-256 over a specified canonical byte representation, and bind that measurement to a protected signed/receipted build record. At validation time require that signed measurement to equal the independently trusted manifest digest; do not accept a source digest supplied by the build record or profile as proof.

### CR-03: Future-dated verification records bypass the freshness window — fixed

**File:** `/Users/sandwich/Develop/napplet-cvm/src/certification/reproducibility.ts:76`
**Issue:** Both persisted-record validators only reject `nowMs - timestamp > maxAgeMs` (`src/certification/reproducibility.ts:76` and `src/certification/supply-chain.ts:120`). Neither rejects a `completedAtMs`/`verifiedAtMs` greater than `nowMs`. Since the schemas permit arbitrary finite nonnegative integers, a rehashed record dated far in the future remains fresh until that future time plus the max age. This defeats the 24-hour protected-evidence freshness control.

**Fix:** Reject timestamps later than the trusted current time before the age calculation, and bound accepted clock skew explicitly (normally zero for a persisted verifier record):

```ts
if (record.verifiedAtMs > nowMs) throw new Error("SUPPLY_CHAIN_RECORD_FROM_FUTURE");
if (nowMs - record.verifiedAtMs > maxAgeMs) throw new Error("SUPPLY_CHAIN_RECORD_STALE");
```

Apply the equivalent check to `completedAtMs` and add future-timestamp regression cases for both records and the promotion evaluator.

### CR-04: Memoized promotion bypasses manifest and evidence authentication — fixed

**File:** `/Users/sandwich/Develop/napplet-cvm/src/promotion/run-promotion.ts:131`
**Issue:** `evaluateReleaseCertification` reads `releaseDecisions` and returns a cached decision before calling `evaluateReleaseCertificationInner`, which is where the new `trustRoot.verifyManifest`, `verifyObservation`, and record verification calls occur (`src/promotion/run-promotion.ts:75-85`). The cache key contains only `candidateId` and `manifest.releaseId`, while its evidence fingerprint contains observations and records but not the manifest or trust-root identity (`src/promotion/run-promotion.ts:131-139`). After a valid invocation has promoted a candidate, a second invocation using the same candidate/release ID and evidence but a changed/untrusted manifest returns the earlier promoted decision without authenticating the new manifest. This defeats the trust-root fix at the direct evaluator/promotion boundary.

**Fix:** Authenticate the manifest before consulting the cache and fingerprint the canonical manifest together with observations and records. Prefer a cache key containing a trusted manifest digest (or authenticated release generation), candidate ID, and evidence digest; reject any mismatch before returning a cached terminal decision. Add a regression that first promotes, then retries with a changed policy/source manifest sharing the release ID and asserts that the trust root is called and the result is blocked.

**Resolved:** `e3217fb` authenticates all candidate-supplied certification facts before cache access, fingerprints canonical manifest/observations/verification records with the candidate ID, and forwards the configured trust root from the promotion runner. The regression retries an unchanged release ID with a changed manifest and verifies the trust root is called again and blocks it.

## Warnings

### WR-01: The supposed immutable Git revision accepts invalid intermediate-length IDs — fixed

**File:** `/Users/sandwich/Develop/napplet-cvm/src/certification/contracts.ts:46`
**Issue:** `sourceRevision` accepts any 40–64 hexadecimal characters; values of 41–63 characters are neither a full SHA-1 nor a full SHA-256 Git object ID. The same loose pattern is used in provenance (`src/certification/supply-chain.ts:20`) and the manifest parser (`src/promotion/schema.ts:104`). This weakens the strict immutable-release schema and permits an ambiguous/non-resolvable revision to be presented as release provenance.

**Fix:** Accept only complete object IDs (or resolve an explicitly supported abbreviated revision against the trusted repository before release):

```ts
const SourceRevisionSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu);
```

### WR-02: The reproducibility CLI has no way to supply the mandatory source-measurement trust root — fixed

**File:** `/Users/sandwich/Develop/napplet-cvm/scripts/verify-phase-07-reproducibility.ts:12`
**Issue:** `verifyReproducibilityRecord` now rejects every call without `options.trustRoot` (`src/certification/reproducibility.ts:56`), but this script calls it with only the parsed input and calls `writeReproducibilityRecord` the same way (`scripts/verify-phase-07-reproducibility.ts:12-13`). Therefore a correctly configured protected records path and output directory can never generate a reproducibility record; it always emits the generic `protected_record_invalid` failure. The tests inject a fake trust root directly and do not exercise this executable path.

**Fix:** Add a protected, digest-pinned trust-root adapter configuration to the command (parallel to the protected certification adapter loader), instantiate it from an operator-controlled store/key configuration, and pass it to both calls. Keep the current fail-closed behavior when that adapter is absent or invalid, and add an end-to-end command test for an authenticated measurement.

**Resolved:** `83bd9e8` adds a digest-pinned, containment-checked protected trust-root loader and requires explicit root directory, module path, and digest configuration. Its concrete trust root reads and hashes configured immutable source archive bytes before accepting a measurement. The executable-path regression covers absent configuration, digest-pinned loading, source-byte mutation rejection, and successful record creation.

---

_Reviewed: 2026-08-05T22:37:29Z; fixes applied 2026-08-05T22:37:29Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: deep_
