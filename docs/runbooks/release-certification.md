# Release certification

Use one command for a candidate:

```sh
bun run release:certify -- --candidate <candidate.json>
```

No workspace argument or environment variable is required: controller state is
stored under the ignored repository-local `.runtime/release-certification`
directory. `NAPPLET_CVM_RELEASE_WORKSPACE` is an optional platform override
only when it is an absolute path within that controller-owned directory; paths
outside it are rejected before controller processing.

The command records a content-addressed state digest. A dry run performs only
local discovery and cost/effect planning; it cannot provision, execute a
protected suite, write protected evidence, finalize trust, promote, or clean
up a provider resource.

Before a protected execution, authenticate the provider clients and approve the
controller-issued cost/effect digest. Do not author or select a certifier
profile, registry, trust root, secret file, observation, or evidence directory:
the controller creates digest-pinned candidate-bound material itself.

The protected completion contract is exact: `admission`, `telemetry`, `chaos`,
`restore`, `security-host`, `supply-chain`, `contextvm-payment-model`, and
`publication` must each have one fresh real record. The admission contract is
locked at 1,000 accepted samples, two 200-attempt forced cohorts, p95 no higher
than 5,000 ms, and zero accepted backlog. Missing, manual, synthetic, stale, or
duplicate records block trust finalization and promotion.

After interruption, rerun the same command with the candidate. To check the
stored redacted state, use `--status`; use `--resume <state-digest>` only when
the returned digest matches. Output contains candidate/topology/state and
authorization digests, never secret values. Cleanup is limited to resources
recorded as created by the approved run; an unresolved required cleanup remains
promotion-blocking.
