# Phase 02 Modal Sandbox API Coverage

**Adapter status:** candidate only  
**Domain boundary:** the project-owned `WorkerPort` remains the complete trusted-core dependency; no Modal type may cross into domain, persistence, admission, capability, or evidence contracts.  
**Offline rule:** missing credentials or probe configuration emits content-addressed `blocked` evidence and leaves Modal unselected. A live `passed` observation establishes only candidate eligibility; production selection and certification remain Phase 7 work.

This inventory covers the Modal JavaScript Sandbox surface deliberately used or rejected by the Phase 2 candidate adapter. Every SDK capability is either integrated behind `WorkerPort` or explicitly excluded from the adapter's strict configuration schema.

| capability | decision | reason |
|---|---|---|
| `ModalClient` with host-side token resolution | INTEGRATE | Constructed only in the coordinator-side adapter; tokens remain in the host process and are never copied into sandbox configuration, commands, evidence, or worker events. |
| `apps.fromName` | INTEGRATE | Resolves the configured probe app with `createIfMissing: false`; the adapter does not create or deploy applications. |
| `images.fromRegistry` | INTEGRATE | Resolves one configuration-pinned image reference for the probe; the image reference is recorded in evidence. |
| `sandboxes.create` | INTEGRATE | Creates one fresh sandbox per live probe behind `WorkerPort`; the SDK object is never exposed to domain code. |
| CPU reservation and `cpuLimit` | INTEGRATE | Both reservation and hard ceiling are required by the strict adapter config and bound into provider evidence. |
| Memory reservation and `memoryLimitMiB` | INTEGRATE | Both reservation and hard ceiling are required and evidenced. |
| `timeoutMs` and `idleTimeoutMs` | INTEGRATE | Explicit bounded lifetime and idle timeout are required; SDK defaults are not relied on. |
| `workdir` | INTEGRATE | Fixed to the session workspace root; worker-supplied paths cannot change it. |
| Entrypoint `command` | INTEGRATE | Fixed adapter-owned argv keeps the sandbox alive for bounded `exec` calls; no shell command string is accepted from the worker. |
| Creation `env` | INTEGRATE | Exact allowlist of non-secret correlation/version values only; arbitrary environment keys are rejected. |
| `blockNetwork: true` | INTEGRATE | Mandatory default-deny egress baseline for every probe sandbox. |
| `regions` | INTEGRATE | Optional configuration-pinned placement used only as provider evidence; the worker cannot choose it. |
| `tags` | INTEGRATE | Non-secret session/action/policy hashes support cleanup and evidence correlation. |
| `Sandbox.exec` | INTEGRATE | Runs adapter-owned literal argv for canaries, runtime checks, denial probes, and checkpoint archive creation with an explicit per-process timeout. |
| Process stdout/stderr and `wait` | INTEGRATE | Output is size-bounded, parsed as untrusted data, hashed/redacted in evidence, and paired with an exit code. |
| `Sandbox.filesystem.copyFromLocal` | INTEGRATE | Transfers only a coordinator-created scoped gateway response or synthetic canary into the assigned workspace. |
| `Sandbox.filesystem.copyToLocal` | INTEGRATE | Retrieves only the validated portable checkpoint archive and probe reports from fixed workspace paths. |
| `Sandbox.filesystem.listFiles` | INTEGRATE | Verifies the fixed workspace boundary and checkpoint inventory; returned metadata is treated as untrusted. |
| `Sandbox.poll` | INTEGRATE | Distinguishes running, exited, and uncertain adapter state without inferring success. |
| `Sandbox.terminate` | INTEGRATE | Runs from `finally` for every created sandbox; termination/timeout still records failure evidence and cannot advance session state. |
| `secrets` at create or exec | OPT-OUT | Worker sandboxes must not receive Modal, model, database, cloud, Nostr, billing, signing, or publication credentials. |
| `volumes` | OPT-OUT | Shared durable mounts would weaken per-session workspace isolation and bypass the portable checkpoint contract. |
| `cloudBucketMounts` | OPT-OUT | Cloud storage credentials and durable checkpoint retention belong to coordinator-owned later-phase adapters. |
| `encryptedPorts`, `h2Ports`, `unencryptedPorts` | OPT-OUT | Phase 2 workers expose no inbound ports or tunnels. |
| `createConnectToken` and `tunnels` | OPT-OUT | The worker has no inbound HTTP authority; scoped tool exchange is coordinator-mediated. |
| `outboundCidrAllowlist` | OPT-OUT | Phase 2 uses full `blockNetwork`; partial egress is not a sandbox permission source. |
| `outboundDomainAllowlist` | OPT-OUT | The documented allowlist surface cannot coexist with `blockNetwork` and is not the product's security baseline. |
| `inboundCidrAllowlist` | OPT-OUT | No port or connection-token surface is created. |
| `updateNetworkPolicy` | OPT-OUT | Runtime opening or mutation of egress would break the fixed default-deny worker contract. |
| `i6pn` | OPT-OUT | Cross-sandbox private networking would create a sibling-session reachability path. |
| `proxy` | OPT-OUT | Arbitrary proxy authority is excluded; approved interactions cross typed coordinator gateways. |
| `includeOidcIdentityToken` | OPT-OUT | A sandbox must not receive ambient cloud identity. |
| `customDomain` | OPT-OUT | The worker is not an externally reachable service. |
| `gpu` | OPT-OUT | The representative Phase 2 contract needs bounded CPU/browser/build behavior only. |
| `pty` | OPT-OUT | Non-PTY streams keep stdout and stderr distinct and machine-verifiable. |
| `readinessProbe` and `waitUntilReady` | OPT-OUT | The adapter uses bounded process/canary checks without opening a service port; production readiness/SLO proof is Phase 7. |
| `detach`, `fromId`, `fromName`, and `list` | OPT-OUT | Phase 2 creates, observes, and terminates one probe in one call; pooling, reattachment, and lease recovery are later-phase concerns. |
| named sandboxes | OPT-OUT | Names can become a provider-side singleton mechanism; session serialization remains in the trusted store, not Modal naming. |
| `setTags` / `getTags` after creation | OPT-OUT | Tags are immutable creation-time correlation facts for this adapter; mutable provider metadata is not authoritative state. |
| `snapshotDirectory` / `snapshotFilesystem` | OPT-OUT | Provider snapshots are not the portable checkpoint contract; Phase 2 exports an app-owned tar/zstd archive plus canonical metadata and hashes. |
| `mountImage` / `unmountImage` | OPT-OUT | Runtime filesystem mutation would expand the adapter surface beyond the pinned probe image. |
| `reloadVolumes` | OPT-OUT | Volumes are excluded entirely. |
| `experimentalCreate` and other V2 experimental methods | OPT-OUT | Experimental backend behavior is not required to prove the candidate contract. |
| `experimentalSidecars` | OPT-OUT | Sidecars add another execution and secret surface without contributing to Phase 2 requirements. |
| filesystem watch APIs | OPT-OUT | The coordinator requests explicit bounded reads; it does not subscribe to untrusted continuous filesystem streams. |

## Evidence contract

The adapter records: SDK/package version, app/image/region identifiers, exact safe creation parameters, sandbox ID hash, resource ceilings, runtime/browser/build versions, own/sibling/host/secret canary outcomes, DNS/HTTP/WebSocket/TCP denial outcomes, scoped-gateway outcome, checkpoint archive manifest/hash, termination outcome, and provider status `passed | failed | blocked`. Raw tokens, credentials, prompt text, gateway grants, and generated source are excluded.

## Primary references

- <https://modal.com/docs/sdk/js/latest/Sandbox>
- <https://modal.com/docs/guide/sandboxes>
- <https://modal.com/docs/guide/sandbox-networking>
- <https://modal.com/docs/guide/sandbox-snapshots>
