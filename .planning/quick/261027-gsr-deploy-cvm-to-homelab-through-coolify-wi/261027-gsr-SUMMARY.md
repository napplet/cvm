---
status: complete
---
# Private homelab CVM deployment

User confirmed existing ChatGPT account + test credits, with production deferred.

- Coolify app `napplet-cvm` (`x13wc0i56wce31hkg4jrtmsq`) on `beta-ssh`.
- Workspace: https://cvm.lab.sandwich.farm; separate preview and Blossom origins.
- Source: private Gogs `owner/napplet-cvm`, branch `main`; source implementation merged in napplet/cvm PR #2. Homelab lifecycle/runbook merged in PRs #114, #116 and #117.
- Persistent private host state at `/srv/homelab/cvm/state`; dedicated engine volume retains database/payment volumes and images. Credentials imported over SSH, never committed. A persistent OS lock fences concurrent control processes.
- Native AMD64 worker checksums, official nested cgroup initialization, network-blocked non-root constrained workers, strict configured HTTPS preview-origin projection and sandboxed public artifact responses.
- Root commands: `./homelab cvm open`, `admin`, `login`, `deploy`, `inspect`, `deployment`, `runtime`, `verify`, `logs`, `restart`, `smoke --allow-chatgpt-usage`, `smoke --restore-only`.

## Verification

25 focused adapter/preview/worker/progress/MCP/integrity tests passed. Compose validation and Python/shell syntax passed. Certificate-validated HTTPS and signed/encrypted public WSS discovery passed with the existing ChatGPT provider selected.

Real ChatGPT generation (`gpt-6.1-sol`) used 15,240 input and 759 output tokens, settled 48 test credits under a 2,266-credit cap, and produced a verified interactive counter. Add changed 0 to 1 in the remote HTTPS preview. The opaque sandbox blocked parent storage and had no Nostr signer.

Artifact: `artifact:sha256:b96be837f656f51da1cc17574b7d2cf07ef4c230adc1dedb41d6eafdbdcafc1d`.

After a Coolify restart, signed WSS discovery retained service key `715bd434527b8e1fd73201bb48ec9b91444229250798c4bbc1c24c32320e4bbf`, and the same artifact reopened and remained interactive. Metered actions, artifacts and usage receipts remained 2/2/2; restoration did not dispatch generation. Local evidence is under `.local/homelab-evidence/`; the retained browser test identity is private, mode 0600, and never stored by the CVM.

## Limits

Private development composition and test credits only. Production certification and real-money service remain deferred. Broad legacy CI is not fully green: payment CI lacks shared config/browser prerequisites, and the ARM GUI runner reports its AMD64 relay is not running. Documentation CI and the targeted/native live checks pass. These failures are disclosed in source PR #2; no production readiness claim is made.
