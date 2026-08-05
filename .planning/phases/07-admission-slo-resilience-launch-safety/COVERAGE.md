# API Coverage — Phase 7 external adapter surfaces

> Full coverage by default. This matrix covers the project-owned adapter operations exercised by Phase 7, not every feature sold by each vendor. Every opt-out is an explicit product or authority boundary.

| capability | decision | reason |
|---|---|---|
| ADM-01 signed ContextVM receipt correlation | INTEGRATE | Bind signed invocation receipt, command fingerprint, and the full receipt-to-exact-ready clock in Plan 07-01. |
| ADM-02 immediately usable durable capacity lease | INTEGRATE | Reserve, probe, bind, compensate, and replay one exact-session lease with zero backlog in Plans 07-01 and 07-05. |
| ADM-03 owner-safe capacity refusal | INTEGRATE | Return stable capacity_unavailable with bounded hint and no hold, session, queue, provider detail, or automatic retry. |
| ADM-04 public HTTP x402 or L402 generation transport | OPT-OUT | ContextVM is the only public v1 transport; x402 and L402 are future adapters. |
| MOD-01 Modal Sandbox create and lifecycle | INTEGRATE | Exercise exact image, resources, region, lifetime, network policy, probe, cleanup, and failure behavior in protected certification. |
| MOD-02 Modal command filesystem checkpoint and termination surface | INTEGRATE | Use only bounded project-port operations with exact-session evidence and no native result authority. |
| MOD-03 Modal process-memory snapshots as durable state | OPT-OUT | SQL fences plus encrypted exact-generation object checkpoints remain authoritative. |
| MOD-04 Modal public inbound ports | OPT-OUT | Isolated workers expose no public ingress; effects cross typed coordinator ports. |
| FLY-01 Fly Machines create start get stop destroy lifecycle | INTEGRATE | Benchmark the same immutable-image lifecycle and readiness contract used for Modal before selection. |
| FLY-02 Fly exact-session health observation | INTEGRATE | Convert native observations into a strict finite project result with protected references. |
| FLY-03 Fly volumes as checkpoint or artifact truth | OPT-OUT | Region-local volumes do not meet the exact retained-object and failure-domain contract. |
| FLY-04 Fly proxy or public generation routing | OPT-OUT | Fly is a lifecycle-only worker candidate; ContextVM remains public ingress. |
| TEL-01 trusted-boundary lifecycle telemetry | INTEGRATE | Cover admission, readiness, model, settlement, checkpoint, resume, validation, publication, reconciliation, and promotion with finite schemas. |
| TEL-02 OpenTelemetry JavaScript API and SDK | INTEGRATE | Install only after official-source, package-identity, Bun, and disposable Collector verification. |
| TEL-03 OTLP HTTP protobuf Collector export | INTEGRATE | Export redacted signals through a digest-pinned Collector while keeping telemetry non-authoritative. |
| TEL-04 automatic provider or worker payload instrumentation | OPT-OUT | Automatic payload capture risks prompts, source, receipts, provider data, and unbounded labels. |
| TEL-05 telemetry backend as durable effect authority | OPT-OUT | SQL state and immutable certification evidence decide money, leases, publication, and promotion. |
| CTX-01 ContextVM signed invoke relay replay and reconnect surface | INTEGRATE | Certify duplicate, out-of-order, reconnect, replay, response, and notification behavior against selected relays. |
| CEP-01 CEP-8 Lightning and Cashu top-up negotiation | INTEGRATE | Exercise supported prepaid top-up discovery and settlement separately from generation metering. |
| CEP-02 CEP-8 as generation ledger authority | OPT-OUT | CEP-8 funds prepaid balance; the internal ledger prices and settles exact validated usage. |
| PAY-01 Lightning invoice intent receipt and lookup | INTEGRATE | Prove one credit and original-operation-only reconciliation for success and ambiguity. |
| PAY-02 Cashu proof policy settlement and lookup | INTEGRATE | Prove trusted-mint enforcement, protected proofs, uniqueness, and one credit. |
| PAY-03 automatic top-up cap increase refund guess or replacement settlement | OPT-OUT | These actions violate prepaid user consent or original-operation reconciliation. |
| MODEL-01 ModelGateway dispatch | INTEGRATE | Dispatch one durable operation under an exact promoted profile, price card, token ceiling, and deadline. |
| MODEL-02 ModelGateway original-operation lookup | INTEGRATE | Resolve ambiguous usage by lookup only, with exact debit and release counters. |
| MODEL-03 provider-native thread retry state as durable authority | OPT-OUT | Provider state cannot resume or replace an ambiguous project operation. |
| SQL-01 PostgreSQL-wire serializable transitions and migrations | INTEGRATE | Apply the exact migration set and exercise serializable money, session, lease, and publication schedules. |
| SQL-02 exact provisioned database failover topology | INTEGRATE | Limit availability claims to the protected topology whose failure drill passes. |
| SQL-03 database-native accepted-work queue | OPT-OUT | Accepted generation work must start immediately or be refused; no durable request queue is allowed. |
| OBJ-01 versioned object create exact-read verify and delete | INTEGRATE | Read, decrypt, verify generation, checksum, owner, version, lease, compatibility, retention, and reattach behavior. |
| OBJ-02 GCS versioning soft-delete and lifecycle policy | INTEGRATE | Record and drill the exact protected bucket policy and its stated failure limits. |
| OBJ-03 object presence or newest-key recovery | OPT-OUT | Presence alone cannot prove exact bytes, identity, fences, decryption, reattachment, or retention. |
| RUN-01 multi-region Cloud Run control plane | INTEGRATE | Certify exact image digests, regional warm floors, ingress loss, and bounded topology claims. |
| RUN-02 Cloud Run untrusted worker execution | OPT-OUT | Generated code executes only in the selected isolated worker provider. |
| HOST-01 compatible-host presentation adapter | INTEGRATE | Render the complete versioned presentation schema and exact state copy outside the iframe. |
| HOST-02 compatible-host NIP-5D sealed preview | INTEGRATE | Prove exact artifact, allow-scripts without same-origin, sender mapping, capabilities, accessibility, and responsive behavior. |
| SIGN-01 host-local signer | INTEGRATE | Sign the exact owner manifest without exposing the private key to the CVM. |
| SIGN-02 external signer | INTEGRATE | Certify the same exact-event contract when the selected compatible host supports it. |
| SIGN-03 CVM user private-key custody | OPT-OUT | User private-key receipt, storage, logging, or substitution is permanently forbidden. |
| NAP-01 promoted napplet CLI facade | INTEGRATE | Validate exact source and asset identity and deploy sealed bytes through named structured operations. |
| NAP-02 pinned napplet package compatibility set | INTEGRATE | Run frozen build, verify, real Chromium conformance, reproducibility, hostile mutations, and formal golden approval. |
| NAP-03 CVM-owned napplet protocol or manifest implementation | OPT-OUT | NIP-5D and the promoted napplet packages remain authoritative. |
| PUB-01 sealed upload and deployment facade | INTEGRATE | Observe one exact deployment under the original publication operation. |
| PUB-02 user-signed owner-event relay facade | INTEGRATE | Publish the already signed manifest once and reconcile only its original operation. |
| PUB-03 CVM attestation relay facade | INTEGRATE | Publish one distinct evidence-bound attestation without replacing owner signing. |
| PUB-04 rebuild re-sign redeploy or replacement event recovery | OPT-OUT | Ambiguity is reconciled by observing stored original operation identities only. |
| SC-01 Sigstore Cosign verification | INTEGRATE | Verify signer identity, digest, and required in-toto predicate for exact candidate inputs. |
| SC-02 machine-readable SBOM generation | INTEGRATE | Pin the selected tool and bind its output to exact images and packages. |
| SC-03 custom project attestation cryptography | OPT-OUT | Reviewed Sigstore policy verification is the trust boundary. |
| CERT-01 typed certification observations and evidence writer | INTEGRATE | Persist canonical passed, failed, blocked, skipped, and not_observed records with freshness and input digests. |
| CERT-02 atomic release promotion gate | INTEGRATE | Reject every missing, stale, mutated, blocked, skipped, or unobserved required input. |
| CERT-03 narrow owner waiver | INTEGRATE | Permit only named time-bounded non-safety waivers with owner, reason, expiry, rollback, and audit linkage. |
| CERT-04 fixture vendor marketing or report self-assertion as live pass | OPT-OUT | Synthetic, structural, self-reported, blocked, or unobserved evidence cannot satisfy live certification. |

## Coverage closure

- Every `INTEGRATE` capability has an executable owner in Plans 07-01 through 07-10 and either deterministic proof or protected live certification.
- Every `OPT-OUT` capability records a permanent boundary, a v1 scope exclusion, or a vendor feature outside the project-owned adapter surface.
- Requirements `SESS-02` and `OPS-01` through `OPS-04`, decisions D-114 through D-129, the Phase 7 UI contract, and the Phase 1/6 deferrals are mapped in the plans and their `must_haves`.
- ContextVM remains the sole v1 public transport; Modal and Fly remain variants behind the provider-neutral worker/capacity/evidence identity.
- Missing protected credentials or topology produce immutable `blocked` or `not_observed` evidence and a nonzero promotion result.
