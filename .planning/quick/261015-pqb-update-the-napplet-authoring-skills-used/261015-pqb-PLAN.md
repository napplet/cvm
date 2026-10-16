---
type: quick
status: complete
---

# Update the development generator's napplet skills

Use the official `npx skills add napplet/napplet` distribution, replacing the obsolete npm skills package. Execute inline through the GSD quick workflow.

1. Install and pin the current make/design/UI/build/SDK/test skills from the official repository, retaining upstream text and provenance for offline development builds.
2. Supply that guidance to the model before source generation and copy the same installed skills into the isolated worker. Keep the bounded source-file, sandbox, verification and billing contracts in force.
3. Verify request contents, worker readiness and the composed generation flow; rebuild/restart the development service only after active work finishes. Document the update command and record results in STATE and this task's summary.

Acceptance: no legacy `@napplet/skills` install in the development worker; current installed skills actually appear in generation requests; pinned offline worker still builds and verifies a conformant napplet; saved ChatGPT subscription sign-in remains usable.

Execution finding: live generated source builds and type-checks, but the scaffold's conformance CLI 0.2.15 injects an empty theme domain, making the valid SDK `themeGet()` call fail (`get is not a function`). Update only the development verification runner in a separate lockfile to current CLI 0.3.4, then recheck the same immutable source before another live request. Preserve generated source, SDK/scaffold pins and conformance enforcement.

The CLI 0.3.4 candidate reproduced the same incomplete theme stub and was discarded. Retain the existing toolchain, document the upstream limitation, and reinforce the skill requirement that optional capabilities degrade safely: handle both synchronous SDK initialization failures and rejected Promises without interrupting the app. Verify real Paja theme handling as well as conformance.
