---
quick_id: 260805-wep
mode: quick
status: ready
files_modified:
  - src/certification/trust.ts
  - src/promotion/candidate.ts
  - scripts/verify-phase-07-release.ts
  - tests/phase-07/promotion-gate.test.ts
---

# Bind protected promotion to fresh source measurement

<objective>
Require the operator-owned protected release command to re-authenticate the manifest-bound source measurement before cache or evaluator authority.
</objective>

<tasks>

<task type="auto" tdd="true">
  <name>Bind protected promotion to source archive bytes</name>
  <files>src/certification/trust.ts, src/promotion/candidate.ts, scripts/verify-phase-07-release.ts, tests/phase-07/promotion-gate.test.ts</files>
  <action>Extend the strict release bundle/composition with one finite source measurement derived from the exact manifest source revision and SHA-256. The protected command must pass it only to its internally loaded pinned root and require `verifySourceMeasurement` before bundle authentication can reach cache lookup or the sole evaluator. Include the measurement in the authenticated/cache fingerprint. Change the valid protected fixture so its immutable source archive bytes hash exactly to the manifest source SHA-256. Add regressions showing archive-byte drift, measurement mutation, omission, counterfeit recomputation, and a permissive candidate-supplied root all remain blocked with nonzero status and no protected-live/promoted claim. Keep the public rootless command fail-closed.</action>
  <verify>bun test tests/phase-07/promotion-gate.test.ts tests/phase-07/reproducibility.test.ts tests/phase-07/supply-chain.test.ts tests/phase-07/certification-runner.test.ts --timeout 10000 &amp;&amp; bun test --timeout 10000 &amp;&amp; ! bun run candidate:verify -- --release-evidence evidence/design/phase-07.json &amp;&amp; ! bun run release:verify:protected -- --release-evidence evidence/design/phase-07.json</verify>
  <done>Protected promotion cannot authorize, cache, or promote a release until its pinned operator root has re-hashed and approved the exact manifest-bound source bytes.</done>
</task>

</tasks>
