---
type: quick
phase: 261109-mxi
plan: 01
wave: 1
depends_on: []
status: complete
autonomous: true
files_modified:
  - src/dev/authoring-tools.ts
  - src/dev/model-tool-loop.ts
  - src/dev/napplet-authoring.ts
  - src/dev/source-proposal-store.ts
  - src/dev/development-model-gateway.ts
  - src/dev/chatgpt-model-gateway.ts
  - src/dev/operator-jobs.ts
  - src/service/migrations.ts
  - migrations/development/018_model_turn_evidence.sql
  - infra/dev-ui/authoring-skills.ts
  - infra/dev-ui/authoring-skills/source.json
  - infra/dev-ui/authoring-skills/skills/
  - infra/service/Dockerfile
  - infra/service/nostrbook-deno.lock
  - infra/dev-ui/Dockerfile
  - infra/dev-ui/visual-dependencies/pnpm-lock.yaml
  - package.json
  - bun.lock
  - tests/dev/authoring-tools.test.ts
  - tests/dev/model-tool-loop.test.ts
  - tests/dev/chatgpt-model-gateway.test.ts
  - tests/dev/model-proposal.integration.test.ts
  - tests/service/migrations-postgres.test.ts
  - tests/dev-ui/visual-authoring.integration.test.ts
must_haves:
  truths:
    - "Both paid model modes can call bounded napplet-skill and read-only Nostrbook tools before returning source."
    - "Every confirmed model turn is durably evidenced and cumulative usage remains inside the signed operation maximum."
    - "Generated Three.js and GSAP imports build, conform and preview from the worker's offline scaffold."
  artifacts:
    - "src/dev/model-tool-loop.ts owns finite turns, calls, byte limits and cumulative usage checks."
    - "src/dev/authoring-tools.ts owns the manifest-only skill reader and fixed Nostrbook allowlist."
    - "migrations/development/018_model_turn_evidence.sql preserves append-only per-turn evidence."
  key_links:
    - "Both gateways use the same tool registry and loop limits while retaining their existing provider wire formats and ambiguity fences."
    - "The authoring resource manifest pins every readable skill byte to provenance, license and digest."
    - "The worker image preloads the exact visual dependencies used by the skill guidance."
---

# Give the generation agent real authoring tools

Replace the current one-shot prompt, which concatenates six skills and explicitly tells the model it has no tools, with a small bounded tool loop. The existing model gateways, operation fences, source store, metering service and isolated worker remain the owning seams. The loop exposes only hash-pinned authoring resources and read-only Nostrbook documentation, then still accepts only the three existing generated source files and sends them through the unchanged worker and artifact gates.

## Locked behavior

- The napplet skill set is a real model-callable resource catalog, with full skill text available by bounded reads. The service contract stays in the developer message and always overrides user prompts, prior source, compiler output, skill text and MCP output.
- Nostrbook runs locally as the pinned `jsr:@nostrbook/mcp@0.3.0` stdio server. The service image builds it reproducibly from a committed Deno lock; generation never invokes `npx`, downloads an MCP package, or accepts a user-selected server or executable.
- Only `read_nip`, `read_kind`, `read_tag`, `read_protocol` and `read_nips_index` are exposed. `read_custom_nip`, arbitrary MCP tools, shell access, filesystem paths and write operations are unavailable.
- Each operation has at most three model turns, eight tool calls, 24 KiB per result and 128 KiB of tool output in total. Tool calls and continuations share the original deadline and cancellation signal.
- Before every continuation, reserve conservatively against the remaining signed input/output maximum and set the provider output limit from the remainder. Aggregate every native turn's usage by dimension; the aggregate may never exceed `intent.maximumUnits`. Original and compiler-repair operations each remain inside the ceilings already approved for that operation.
- Persist immutable, intent-bound per-turn response identity and usage before executing tools or sending another request. A known final or known tool failure produces one aggregate normalized receipt before parsing source. A later ambiguous request remains `usage_unknown`, retains earlier turn evidence for reconciliation, and is never replayed or silently charged as a complete aggregate.
- Three.js and GSAP are scaffold-owned, exact-version offline dependencies. Generated code may import them from the existing three source files, but cannot edit dependencies, fetch CDNs, add plugins, or weaken the sandbox/CSP.

## Tasks

<task type="tracer" tdd="true">
  <name>Run one skill read through the configured Responses gateway and retain exact turn evidence</name>
  <files>src/dev/authoring-tools.ts, src/dev/model-tool-loop.ts, src/dev/napplet-authoring.ts, src/dev/source-proposal-store.ts, src/dev/development-model-gateway.ts, src/service/migrations.ts, migrations/development/018_model_turn_evidence.sql, tests/dev/authoring-tools.test.ts, tests/dev/model-tool-loop.test.ts, tests/dev/model-proposal.integration.test.ts, tests/service/migrations-postgres.test.ts</files>
  <behavior>Model requests one manifest-known napplet skill -> bounded exact bytes are returned -> continuation emits strict source JSON -> each native response usage is stored before continuation -> one aggregate receipt and proposal result; unknown skill/path traversal/oversized call -> bounded tool error; malformed final source -> aggregate known usage is still retained and settled; ambiguous continuation -> earlier turn evidence remains but no retry or false complete receipt occurs.</behavior>
  <action>Create a hash-checked `AuthoringToolRegistry` with a catalog plus a chunked `read_authoring_resource` function that can address only resources named by `infra/dev-ui/authoring-skills/source.json`. Refactor `nappletAuthoringInstructions` to send the catalog, routing instructions and unchanged mandatory source contract instead of concatenating every skill or claiming no tools. Add a provider-neutral loop state machine for limits, remaining-unit checks, tool dispatch and deterministic continuation keys; keep provider wire parsing in each gateway. Append migration 018 for immutable `(operation_id, turn_index)` evidence bound to the intent digest, provider/model/response ID and ordered usage receipt, with conflict and provider-response uniqueness checks. Record each confirmed turn before tool execution; expose the evidence in existing operator job detail without logging prompt, credentials or full remote documents. Update the configured Responses gateway to parse function calls, execute the shared registry, post `function_call_output` continuations with per-turn idempotency keys, aggregate native usage, persist the aggregate through the existing usage-evidence path before source parsing, and preserve lookup-only recovery after any uncertain request. Use conservative UTF-8 request bytes as an upper bound for remaining input tokens and the remaining provider-native output envelope for `max_output_tokens`.</action>
  <verify><automated>bun test tests/dev/authoring-tools.test.ts tests/dev/model-tool-loop.test.ts tests/dev/model-proposal.integration.test.ts tests/service/migrations-postgres.test.ts</automated></verify>
  <done>A real configured-provider generation can choose and read a napplet skill, finish with verified-format source, and produce durable per-turn evidence plus one exact aggregate receipt without exceeding or reinterpreting its approved maximum.</done>
</task>

<task type="auto" tdd="true">
  <name>Add pinned Nostrbook reads and the same bounded loop to ChatGPT OAuth</name>
  <files>src/dev/authoring-tools.ts, src/dev/model-tool-loop.ts, src/dev/chatgpt-model-gateway.ts, infra/service/Dockerfile, infra/service/nostrbook-deno.lock, package.json, bun.lock, tests/dev/authoring-tools.test.ts, tests/dev/model-tool-loop.test.ts, tests/dev/chatgpt-model-gateway.test.ts</files>
  <behavior>Agent calls an allowed Nostrbook tool -> fixed local MCP process returns bounded untrusted text -> OAuth continuation produces source -> all turns aggregate into one receipt; disallowed `read_custom_nip`, unknown tools, timeout, invalid MCP framing or output overflow -> safe bounded error and no extra capability; interrupted/ambiguous OAuth turn -> SQL operation fence prevents replay and confirmed earlier usage remains visible.</behavior>
  <action>Use the official Model Context Protocol SDK client over stdio and a fixed executable path. Add a pinned Deno build stage to `infra/service/Dockerfile` that compiles `jsr:@nostrbook/mcp@0.3.0` from `infra/service/nostrbook-deno.lock` into the image with network permission limited to Nostrbook and the official NIPs source; do not invoke `npx` at runtime. Map only the five locked read tools into the model-facing registry, validate their existing Nostrbook schemas, share the operation deadline, kill the child on timeout/cancel, cap returned text, and treat it as untrusted data. Extend ChatGPT streaming response parsing to retain function-call items and run the same finite loop, using deterministic turn bindings under the existing `SqlChatGptOperations.claim` fence. Aggregate and persist usage from every completed streaming response before parsing final source; never issue another provider request when a response outcome is uncertain. Tests use deterministic MCP-reader fixtures and provider streams, including multiple calls, cumulative limits, known failure and an ambiguous second turn; the compiled stdio MCP is independently exercised against its real documentation origins; they must assert no credentials, private paths or arbitrary executable selection enter requests or diagnostics.</action>
  <verify><automated>bun test tests/dev/authoring-tools.test.ts tests/dev/model-tool-loop.test.ts tests/dev/chatgpt-model-gateway.test.ts tests/dev/chatgpt-diagnostic.test.ts</automated></verify>
  <done>API-key and OAuth generation expose the same skills and read-only Nostrbook knowledge with identical bounds, exact aggregate accounting and no new retry, server-selection or write surface.</done>
</task>

<task type="auto" tdd="true">
  <name>Ship licensed visual skills with offline Three.js and GSAP builds</name>
  <files>infra/dev-ui/authoring-skills.ts, infra/dev-ui/authoring-skills/source.json, infra/dev-ui/authoring-skills/skills/, infra/dev-ui/Dockerfile, infra/dev-ui/visual-dependencies/pnpm-lock.yaml, src/dev/napplet-authoring.ts, tests/dev/napplet-authoring.test.ts, tests/dev-ui/visual-authoring.integration.test.ts</files>
  <behavior>Visual task -> agent can selectively read GSAP core/timeline/utils/performance and Three.js fundamentals/lighting/shaders/postprocessing guidance -> generated imports resolve during the worker's offline frozen install -> strict TypeScript, single-file build, conformance and sandboxed Chromium preview pass; reduced-motion GSAP example and resized/disposed Three.js scene render without network; unrelated task need not load visual guidance.</behavior>
  <action>Vendor only redistributable skill snapshots with a source URL, immutable revision, license and SHA-256 in the existing authoring resource manifest. Keep the six napplet skills pinned to their current upstream revision; add vanilla-relevant GSAP guidance and Three.js r186 guidance, including any directly referenced resource files needed to follow those skills. Do not copy material whose license or provenance cannot be established. Pin scaffold-owned `three@0.186.0` and `gsap@3.13.0` (core package only) with registry integrity and license metadata in `visual-dependencies.lock.json`; update the worker template during image build so its committed/frozen dependency graph is fully populated in `/opt/pnpm-store` and `run-proposal.ts` continues using `--offline --frozen-lockfile --ignore-scripts`. Keep model-writable paths unchanged. Add a real isolated-worker integration fixture that builds and previews one compact Three.js napplet and one GSAP napplet, checks zero CDN/browser egress, animation cleanup and `prefers-reduced-motion`, and runs the existing verification/conformance/dry-run stages. Update skill integrity tests to reject renamed, missing, unlicensed, unlisted or mismatched resources.</action>
  <verify><automated>bun test tests/dev/napplet-authoring.test.ts tests/dev-ui/visual-authoring.integration.test.ts &amp;&amp; bunx --package typescript@5.9.3 tsc --noEmit --pretty false</automated></verify>
  <done>The agent has usable visual guidance and the isolated worker can actually compile, conform and preview Three.js/GSAP output entirely offline, while ordinary napplets retain the same source and capability boundaries.</done>
</task>

## Threat model

| Boundary | Risk | Required control |
| --- | --- | --- |
| Model -> local tools | Arbitrary tool, path, command or call amplification | Static schemas and allowlists; manifest-only resources; finite rounds/calls/bytes/deadline |
| Nostrbook -> model | Prompt injection, mutable/oversized remote text, network pivot | Treat output as user data; five read tools only; fixed compiled server; host-restricted network; byte caps |
| Multi-turn provider -> billing | Hidden extra spend, lost first-turn usage, duplicate continuation | Remaining-unit gate before each turn; immutable turn evidence; deterministic IDs; aggregate receipt; no retry after ambiguity |
| Generated source -> worker | Dependency/config mutation, CDN fetch, renderer resource leak | Three writable files only; scaffold-owned exact deps; CSP/network denial; build/conformance/Chromium checks |
| Package and skill supply chain | Substitution or incompatible guidance | Immutable revisions, hashes, locks, integrity/license metadata, pinned container digests and fail-closed startup validation |

## Acceptance

- A fixture model in each provider mode requests a napplet skill and a Nostrbook read, then returns valid source; tool results are visible to the continuation and never inserted as trusted developer instructions.
- Three or fewer model responses settle as one normalized receipt whose usage equals the sum of immutable per-turn evidence and stays within the original signed intent. Final-source failure still retains/settles all known usage; ambiguity retains confirmed evidence and dispatches nothing again.
- The live image contains a reproducible local Nostrbook MCP executable and performs no per-generation package download. Only the five approved documentation tools are callable.
- The resource catalog fails closed on tampering and includes pinned, licensed napplet, GSAP and Three.js guidance. The tool cannot read any other service file.
- Real worker fixtures build, verify, conform and preview Three.js and GSAP napplets with the network disabled and the existing source-size, CSP, capability and artifact gates intact.
- Stop when these proofs pass. Do not add a general shell, arbitrary MCP gateway, autonomous package installation, new queue/runtime, private deployment data, or provider-specific architecture.
