# Capability-compatible CLI source intake

The separate `capabilities-0.13.0` profile prepares a reproducible CLI source
input. It does not select a production toolchain, change the worker image, run a
protected suite, or authorize deployment. The historical default remains CLI
0.5.2 so existing source recipes and operation identities remain available.

From the repository root:

```sh
bun test tests/runner/cli-source-build-profiles.test.ts tests/runner/capability-cli-intake.test.ts tests/runner/source-build-candidate.test.ts
bun scripts/verify-capability-cli-source-build.ts
bun scripts/rebuild-napplet-cli-source.ts --profile capabilities-0.13.0 --output /absolute/empty/intake-directory
bun scripts/verify-capability-cli-source-build.ts --receipt /absolute/empty/intake-directory/receipt.json
```

The recipe pins upstream commit `3c6e3ae33fea425b2f151740c0bd8c02f509ef7b`,
CLI 0.13.0, Deno 2.9.6, build/probe images, the original upstream lock and a
separate reviewed lock overlay. The upstream standalone lock is stale for its
source imports. One preparation resolution produced the committed overlay;
every comparison build uses frozen inputs and the final compile has no network.
The verifier checks the upstream lock from Git and the effective build lock
separately, and refuses other checkout changes. It also rehashes the actual
harness, runtime, both binaries per architecture and their retained source trees.
New-profile probes run without network, as UID65532, with a read-only root.

The two Linux architectures have distinct probe manifest digests from the same
pinned Bun image index. Reusing one index digest across both platforms fails on
Docker image stores that cannot replace an existing platform binding. Bounded
probe output is retained before failure; failed checks remain failures.

Before this can become the worker toolchain, finish the coherent SDK/plugin,
frozen scaffold and real Chromium compatibility gates. The newer plugin emits
a direct artifact `x` hash and R/O capability tags; the existing service uses
legacy path/aggregate manifests. Its artifact verifier, archive readers,
publication contexts and compatible host need an explicit migration that keeps
historical records readable and preserves original operation identities.

The new plugin requires description metadata. The CLI also enables catalog and
automatic screenshot publication by default. The napplet-manifest-only service
path uses its documented `--no-zapstore` option; real Chromium conformance and
host verification remain mandatory independent checks. Optional catalog tooling
has a separately managed private Node/browser cache which must be pinned and
prepared before any future offline use.

Use the sole release evaluator and exact bounded authorization flow described
in [release certification](release-certification.md) after the full composition
and eight real suites are ready. This intake has no selected candidate or
protected evidence. Keep historical images/readers for explicit resume and
rollback; do not rewrite older archive or publication identities.
