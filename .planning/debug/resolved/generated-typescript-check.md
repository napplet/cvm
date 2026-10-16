---
status: resolved
trigger: "GUI screenshot: Check guidance and TypeScript failed after Build napplet completed"
created: 2026-10-16T01:09:00Z
updated: 2026-10-16T01:13:43Z
---

## Symptoms

Expected: A submitted idea produces a verified usable napplet through the signed-in ChatGPT subscription.
Actual: Source streams and builds, then the guidance/TypeScript stage fails; GUI shows only stage names.
Timeline: New request after the stream assembly fix and a successful counter smoke.
Reproduction: Latest real development GUI generation from user screenshot at 18:07 local.

## Current Focus

hypothesis: Confirmed: generation prompts require runtimeHasDomain but omit its required domain argument; generated source calls runtimeHasDomain().
test: Correct the prompt contract, verify the original source with only the missing argument supplied, and run a new live blinking-text generation.
next_action: None for this failure. Production remains deferred.

## Evidence

- Screenshot confirms model, installation and Vite build completed; the first failed stage is verify.
- Latest durable source proposal 56f0a1887758abcb3b9bc27ce5361f56c886063e6df4b8de6783f8657ca79a78 contains runtimeHasDomain() at src/main.ts:4. Replaying only its build in the pinned network-isolated worker reproduces TS2554: Expected 1 arguments, but got 0. All six guidance checks passed.
- Pinned scaffold defines runtimeHasDomain(domain: string): boolean. Both development model prompts mandated a call but supplied only an import. Added the signature and void runtimeHasDomain('storage'); example to both.
- Corrected original source (in memory only, immutable proposal unchanged) passes all eight worker stages including Chromium conformance and deployment dry run. No model request or ledger mutation needed for this reproduction.
- Added bounded compiler diagnostics (approved source path, numeric location, TypeScript code and optional argument counts) to progress; no raw compiler message, source or logs cross the boundary. GUI keeps the diagnostic after completion and clears it on the next action.
- 27 targeted unit tests / 181 assertions pass, browser activity checks pass, composed OAuth browser journey passes with specific TS2322 failure feedback and raw-output exclusion.
- Two configured-provider integration tests / 21 assertions pass with fixture HTTP; no API-key inference was used.
- Fresh real gpt-6.1-sol subscription generation passed via the standard service: blinking text, complete build/verification, sandbox preview, running animation and reduced-motion stop. No automatic retries. Standard GUI remains running with the existing OAuth selection.

## Resolution

root_cause: Both generation prompts required the scaffold helper call but omitted its required domain parameter. The model produced runtimeHasDomain(), which Vite builds but TypeScript rejects with TS2554.
fix: Supply the correct signature and example in generation context. Project bounded compiler diagnostics into caller-scoped progress and retain them in the GUI after a failure.
verification: Original source reproduced then passed with the missing argument supplied; fresh live blinking-text subscription generation passed; 29 targeted unit/integration tests and two browser journeys passed. Immutable proposals, receipts and verification gates are preserved.
