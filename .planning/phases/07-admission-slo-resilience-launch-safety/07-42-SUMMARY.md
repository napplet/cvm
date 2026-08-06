---
phase: 07-admission-slo-resilience-launch-safety
plan: 42
subsystem: release-deployment
tags: [contextvm, cep-8, cashu, vertex, nip-46, napplet, blossom, nostr, no-effect]
requires:
  - phase: 07-41
    provides: Shared bounded Google client and unselected worker primitives
provides:
  - Complete deployment-owned registry for ContextVM, payment, Vertex, host, signer, CLI, upload, and relay families
  - Reference-only service and owner key custody descriptors with strict original-operation reconciliation
  - Loopback/fake-only client coverage for all ten non-infrastructure provider families
affects: [07-43, 07-44, 07-20, 07-26]
tech-stack:
  added: []
  patterns: [official-sdk-canonical-correlation, reference-only-key-custody, original-operation-reconciliation, injected-no-effect-clients]
key-files:
  created:
    - src/release/deployment/contextvm-client.ts
    - src/release/deployment/payment-clients.ts
    - src/release/deployment/vertex-client.ts
    - src/release/deployment/compatible-host-client.ts
    - src/release/deployment/nip46-signer-client.ts
    - src/release/deployment/cli-upload-clients.ts
    - src/release/deployment/relay-clients.ts
  modified:
    - src/release/deployment/factory.ts
    - tests/release/deployment-contextvm-payment-model-clients.test.ts
    - tests/release/deployment-host-signer-clients.test.ts
    - tests/release/deployment-publication-clients.test.ts
decisions:
  - "All ten provider families are registered only through an exact complete deployment-client map; partial maps are rejected."
  - "ContextVM correlation calls the installed official SDK primitive while retaining only the service key reference and redacted correlation facts."
  - "NIP-46 uses a disposable client-key reference and external owner-key custody; owner and attestation relays cannot share a role or key reference."
metrics:
  duration: 6m 24s
  completed: 2026-08-06
  tasks_completed: 3
  files_changed: 11
status: complete
---

# Phase 07 Plan 42: Concrete Protocol and Publication Client Summary

**All ten non-infrastructure deployment families now use reference-only, original-operation-bound concrete client descriptors with fixture-only verification.**

## Accomplishments

- Added official `@contextvm/sdk` canonical invocation correlation tied to a service-owned key reference, NWC/Cashu consent references, and a shared-Google Vertex Gemini descriptor.
- Added promoted napplet reference-host/Chromium and external NIP-46 client composition while preserving zero user private-key custody.
- Added exact promoted CLI/Blossom upload and distinct owner/attestation relay descriptors, then registered the complete ten-family factory map.

## Task Commits

1. **Task 1: Wire official ContextVM, funded-rail, and Vertex reconciliation clients**
   - `9d415fa` test(07-42): add failing contextvm payment model coverage
   - `df90237` feat(07-42): add contextvm payment and vertex clients
2. **Task 2: Prove the promoted napplet in the reference host and request owner signing over NIP-46**
   - `adafa92` test(07-42): add failing host signer coverage
   - `27419eb` feat(07-42): add compatible host and NIP-46 clients
3. **Task 3: Wire promoted CLI/upload and distinct owner/attestation relay clients**
   - `cd9429c` test(07-42): add failing publication client coverage
   - `20dbad6` feat(07-42): add promoted publication clients
   - `b746417` feat(07-42): require complete deployment client registry

## Verification

- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/deployment-contextvm-payment-model-clients.test.ts tests/release/deployment-host-signer-clients.test.ts tests/release/deployment-publication-clients.test.ts --timeout 10000` — passed (10 tests).
- Task-focused native/provider suites for ContextVM/payment/model, host/signer, and publication — passed.
- `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test --timeout 10000` — passed (644 tests).
- No-effect proof: all exercised interactions were injected fakes or local fixture values. No authenticated discovery, provider mutation, payment transfer, NIP-46 consent/signing, ContextVM/Nostr relay traffic, ADC metadata access, Vertex billing, external host/browser, publishing CLI, upload, relay event, protected evidence, promotion, or cleanup ran.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] Corrected the official ContextVM SDK import path**
- **Found during:** Task 1 verification
- **Issue:** `@contextvm/sdk/payments` does not export its canonical-identity helper from its barrel in the installed `0.13.10` package.
- **Fix:** Imported the documented installed subpath `@contextvm/sdk/payments/canonical-identity` instead.
- **Files modified:** `src/release/deployment/contextvm-client.ts`
- **Commit:** `df90237`

## Known Stubs

None.

## Threat Flags

None. All new externally relevant paths are reference-only descriptors that reject raw secret/key-shaped values and do not initiate an effect during construction.

## Next Phase Readiness

Plan 07-43 can consume the exact complete client-family map to build the eight real protected suite constructors. Real consent is still owned by 07-20, and every real protocol/provider effect remains exclusive to 07-26 after exact authorization validation.

## Self-Check: PASSED

- Confirmed all seven created deployment modules, factory registration, and all three named test files exist.
- Confirmed all seven TDD and feature commits exist in git history.
