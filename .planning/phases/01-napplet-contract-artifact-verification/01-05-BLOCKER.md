# Plan 01-05 Blocker: Official Resolver-Free CLI Release

## Why execution stopped

The approved `@napplet/cli@0.5.1` standalone binary delegates `napplet create` and
`napplet skills` through `npx --yes`. Plan 01-04's sealed runtime intentionally has
no package resolver and denies those subprocesses. Using a CVM shim or a branch-built
binary would violate the locked trust rule that napplet packages own and repair NIP-5D
behavior.

The Plan 01-05 RED contract is committed as `c31cd0b`. No failing candidate was
promoted and no trusted pointer was changed.

## Upstream remediation

- Pull request: https://github.com/napplet/web/pull/200
- Branch: `fix/cli-resolver-free`
- Head when handed off: `3d3c69f37a682983d71dc4e4994544901a60b8cc`
- Result: standalone `create` and `skills` dispatch directly into the maintained
  `@napplet/boilerplate` and `@napplet/skills` package CLIs; shipped skills are
  embedded in the compiled binary; runtime package-resolution is unnecessary.
- Verification: CI, conformance, link-check, and AI-slop checks all pass. The CLI
  suite passes 118 tests, including a relocated compiled-binary run with an empty
  `PATH` and disabled proxy.
- Merge: PR #200 merged as `b17e9447985f7290a76f184142cfcaa92d2627f0`.
- Release follow-up: Publish run `30832804324` exposed an npm-wildcard-to-JSR
  synchronization bug. The fixture-backed fix is in
  https://github.com/napplet/web/pull/201; main CI and AI-slop checks pass, with
  conformance still running at this handoff.

## Safe resume criteria

1. Merge release-tooling follow-up PR #201 through the upstream repository's
   normal review policy.
2. Allow the Publish workflow to create/update the Version Packages PR, merge
   that release PR, and publish the successor official `@napplet/cli` release.
3. Confirm checksum-addressed standalone assets are attached, including the
   architecture required by the sealed builder.
4. Detect that official release as a new candidate; do not reuse the old candidate ID
   or approval.
5. Repeat provenance review and explicit approval for the new content-derived
   candidate ID.
6. Rebuild and verify the deterministic sealed image from the newly approved official
   asset.
7. Resume Plan 01-05 and turn the committed RED fixture contract green.

Until all seven conditions hold, Phase 1 remains correctly blocked rather than weakened.
