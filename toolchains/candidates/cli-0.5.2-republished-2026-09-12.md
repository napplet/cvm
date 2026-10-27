# `@napplet/cli@0.5.2` republished asset intake snapshot

Status: **not promoted; source-to-binary provenance remains a release gate.**

The immutable historical candidates `cli-0.5.2.json` and
`cli-0.5.2-release-set.json` retain their original asset digest and must not be
rewritten.  On 2026-10-27 the official GitHub release endpoint for the same
tag returned a recreated Linux x86_64 asset:

- Release tag: `@napplet/cli@0.5.2`
- Asset URL: `https://github.com/napplet/web/releases/download/%40napplet/cli%400.5.2/napplet-linux-x86_64`
- Official release asset ID: `560100559`
- Recreated at: `2026-09-12T23:02Z`
- Size: `291395616` bytes
- Official and locally measured SHA-256:
  `a17fd2f61beb3b1553518b517045c4e1a474ddee5db87be80e18cf1bd24d8e28`
- The executable is a Linux x86-64 ELF and, under a Linux/amd64 container,
  exposes the expected `napplet create`, `init`, `deploy`, and `conformance`
  commands.

This is an intake pin for the production-worker image only.  It is not an
approval to promote or select a release set: the recreated asset was produced
by upstream workflow commit `976ad0549c38f93d4ed418d3ea59a615a7e5fd7f`,
not the historical tag commit `1a38b9150f3a3da148091c11bce4d0365f7298e5`.
Compatibility with the sealed boilerplate, Chromium conformance, and the
source-to-binary mapping must be demonstrated before promotion.
