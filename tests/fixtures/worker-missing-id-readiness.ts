import { expect } from "bun:test";
import { createFlyMachinesHttpTransport, createWorkerDeploymentClients, PRODUCTION_WORKER_POLICY,
  type WorkerOperationJournal } from "../../src/release/deployment/worker-clients";
import { createProductionReadyCapacity } from "../../src/production/worker-capacity";
import type { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";

const digest = (value: string) => value.repeat(64);
const image = `registry.example/worker@sha256:${digest("a")}`;
const appName = "lost-worker-readiness";

/** Native fixtures exercise actual transport/capacity code, not live evidence. */
export async function proveMissingIdReadiness(provider: "modal" | "fly", persistence: Readonly<{
  journal(): WorkerOperationJournal;
  capacity?: Readonly<{ journal(): PostgresOperationJournal; workerJournal: PostgresOperationJournal }>;
}>, finish: "retirement" | "deadline" | "native-retirement" | "legacy-retirement" = "retirement") {
  let nativeId = "", operationId = `lost-${provider}-readiness`, visible = false, creates = 0, probes = 0, queries = 0;
  let tags: Record<string, string> = {}, originalMachine: Record<string, unknown> | undefined;
  let lookup: "exact" | "missing" | "unknown" | "wrong" = "exact", validProbe = true;
  let capacityNow = Date.now(), duringProbe: (() => Promise<void>) | undefined;
  const binding = { intentReference: `capacity-intent:${digest(finish === "legacy-retirement" ? (provider === "modal" ? "b" : "c") : finish === "native-retirement" ? (provider === "modal" ? "9" : "a") : (provider === "modal" ? "7" : "8"))}`, expectedSessionBindingDigest: `sha256:${digest("b")}` };
  let releaseTermination = () => {}, enterTermination = () => {}, terminations = 0;
  const terminationGate = new Promise<void>(resolve => { releaseTermination = resolve; });
  const terminationEntered = new Promise<void>(resolve => { enterTermination = resolve; });
  const terminate = async () => {
    if (finish !== "native-retirement") throw new Error("READINESS_CANNOT_TERMINATE");
    terminations++; enterTermination(); await terminationGate;
    visible = false; throw new Error("TERMINATION_ACK_LOST");
  };
  const probe = async (command: readonly string[]) => {
    probes++;
    expect(command.slice(0, 3)).toEqual(["/usr/local/bin/napplet-cvm-bootstrap", "/usr/local/bin/napplet-cvm-probe", "observe-isolation"]);
    await duringProbe?.();
    const record = await persistence.journal().read(operationId);
    if (!record) throw new Error("ORIGINAL_REQUIRED");
    return JSON.stringify({ checks: { toolchain_readonly: true, workspace_bounded: true, non_root: true, no_ambient_credentials: true,
      network_denied: validProbe, no_inbound_ports: true, minimal_capabilities: true },
      exactReady: { image, sessionLeaseSha256: record.sessionLeaseSha256, toolchainSha256: record.toolchainSha256, remainingLifetimeMs: 60_000 } });
  };
  const sandbox = { id: `original-${provider}-sandbox`, getTags: async () => lookup === "wrong" ? { ...tags, "napplet-cvm-lease-sha256": digest("f") } : tags,
    exec: async (command: readonly string[]) => ({ stdout: await probe(command), stderr: "", exitCode: 0 }), poll: async () => ({}),
    terminate,
    filesystem: { copyFromLocal: async () => {}, copyToLocal: async () => {}, listFiles: async () => [] } };
  const openClients = () => createWorkerDeploymentClients({ image, workspaceRoot: "/workspace", policyVersion: PRODUCTION_WORKER_POLICY.version,
    modalAppName: appName, modalTags: {}, journal: persistence.journal(),
    modalSdk: { apps: { fromName: async () => ({}) }, images: { fromRegistry: () => ({}) }, sandboxes: {
      async create(_app, _image, options) { creates++; tags = { ...options.tags }; operationId = tags["napplet-cvm-operation"]!; nativeId = sandbox.id; visible = true; throw new Error("CREATE_ACK_LOST"); },
      async findByName() { queries++; return !visible || lookup === "missing" ? { kind: "missing" as const } : lookup === "unknown" ? { kind: "unknown" as const } : { kind: "found" as const, sandbox }; },
    } },
    fly: createFlyMachinesHttpTransport({ appName, journal: persistence.journal(), getAccessToken: async () => "local-provider-fixture-token",
      async fetch(url, init) {
        const parsed = new URL(url);
        expect(parsed.origin).toBe("https://api.machines.dev");
        if (init.method === "POST" && parsed.pathname.endsWith("/exec")) {
          return Response.json({ stdout: await probe(JSON.parse(String(init.body)).command), stderr: "", exit_code: 0 });
        }
        if (init.method === "POST" && parsed.pathname === `/v1/apps/${appName}/machines`) {
          creates++; const body = JSON.parse(String(init.body)); operationId = body.config.metadata["napplet-cvm-operation"]; nativeId = "original-fly-machine";
          originalMachine = { ...body, id: nativeId, state: "started", created_at: new Date().toISOString() }; visible = true; throw new Error("CREATE_ACK_LOST");
        }
        if (init.method === "DELETE") { await terminate(); throw new Error("UNREACHABLE_TERMINATION_ACK"); }
        if (init.method !== "GET") throw new Error("READINESS_CANNOT_MUTATE_PROVIDER");
        queries++;
        if (parsed.searchParams.has("metadata.napplet-cvm-operation")) {
          if (lookup === "unknown") return new Response("unavailable", { status: 503 });
          if (!visible || lookup === "missing") return Response.json([]);
          return Response.json([lookup === "wrong" ? { ...originalMachine, config: { image: `registry.example/foreign@sha256:${digest("f")}` } } : originalMachine]);
        }
        return visible ? Response.json(originalMachine) : new Response(null, { status: 404 });
      } }),
  });
  const openCapacity = () => {
    if (!persistence.capacity) throw new Error("SQL_CAPACITY_REQUIRED");
    return createProductionReadyCapacity({ provider, workers: openClients(), journal: persistence.capacity.journal(), workerJournal: persistence.capacity.workerJournal,
      image, toolchainSha256: digest("c"), flyRegion: "ams", now: () => capacityNow });
  };
  const observe = () => persistence.capacity ? openCapacity().observe(binding) : openClients()[provider].observe({ operationId });
  expect((await observe()).status).not.toBe(persistence.capacity ? "available" : "completed");
  expect({ creates, probes, queries }).toEqual({ creates: 0, probes: 0, queries: 0 });
  const intent = { operationId, sessionLeaseSha256: digest("b"), toolchainSha256: digest("c"), providerDeadlineEpochMs: Date.now() + (finish === "deadline" ? 100 : 60_000) };
  const allocated = persistence.capacity ? await openCapacity().reserveNow(binding)
    : provider === "modal" ? await openClients().modal.create(intent) : await openClients().fly.create({ ...intent, region: "ams" });
  expect(allocated.status).toBe("unknown");
  expect((await persistence.journal().read(operationId))?.resourceId).toBeUndefined();
  for (const mode of ["missing", "unknown", "wrong"] as const) {
    lookup = mode;
    expect((await observe()).status).toBe("unknown");
    expect((await persistence.journal().read(operationId))?.resourceId).toBeUndefined();
    expect({ creates, probes }).toEqual({ creates: 1, probes: 0 });
  }
  lookup = "exact"; validProbe = false;
  expect((await observe()).status).toBe("unknown");
  expect((await persistence.journal().read(operationId))?.resourceId).toBe(nativeId);
  validProbe = true;
  const ready = await observe();
  expect(ready.status).toBe(persistence.capacity ? "available" : "completed");
  const repeated = await observe();
  expect(repeated.status).toBe(ready.status);
  if (ready.status === "available" && repeated.status === "available") {
    expect(ready.ready.imageDigest).toBe(`sha256:${digest("a")}`);
    expect(ready.ready.sessionBindingDigest).toBe(binding.expectedSessionBindingDigest);
    expect(repeated.ready).toEqual(ready.ready);
  }
  expect(creates).toBe(1);
  if (persistence.capacity) {
    const record = await openCapacity().inspect(binding);
    if (!record) throw new Error("CAPACITY_ORIGINAL_REQUIRED");
    // Expiry during a successful native probe must not become usable capacity.
    duringProbe = async () => { capacityNow = record.deadlineEpochMs + 1; };
    expect((await observe()).status).toBe("unknown");
    const beforeExpired = { queries, probes };
    expect((await observe()).status).toBe("unknown");
    expect({ queries, probes }).toEqual(beforeExpired);
    capacityNow = record.deadlineEpochMs - 1;
  }
  if (finish === "legacy-retirement") {
    const record = await persistence.journal().read(operationId);
    if (!record) throw new Error("ORIGINAL_REQUIRED");
    const sha = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
    // Exact pre-change companion identities; its CREATE row was still active.
    const created = provider === "fly" ? { providerCreatedAtMs: record.providerCreatedAtMs } : {};
    const terminationId = `t-${sha({ operationId, resourceId: record.resourceId, image: record.image, requestSha256: record.requestSha256, ...created }).slice(0, 46)}`;
    const terminationRequest = sha({ original: operationId, resourceId: record.resourceId, image: record.image, requestSha256: record.requestSha256, ...created, action: "terminate" });
    const { state: _state, resourceId: _resourceId, ...facts } = record;
    await persistence.journal().claim({ ...facts, operationId: terminationId, requestSha256: terminationRequest });
    const beforeLegacyRead = { queries, probes };
    expect((await observe()).status).toBe("unknown");
    expect({ queries, probes }).toEqual(beforeLegacyRead);
    expect((await persistence.journal().read(operationId))?.state).toBe("terminating");
    expect(await persistence.journal().read(terminationId)).toMatchObject({ requestSha256: terminationRequest, state: "claimed" });
    expect({ creates, terminations }).toEqual({ creates: 1, terminations: 0 });
    return;
  }
  if (finish === "native-retirement") {
    let stateDuring: string | undefined, nestedStatus: string | undefined, visibleAtFence = false;
    duringProbe = async () => {
      const stopping = openClients()[provider].terminate({ operationId }).catch(() => ({ status: "unknown" as const }));
      try {
        await terminationEntered;
        stateDuring = (await persistence.journal().read(operationId))?.state;
        visibleAtFence = visible;
        // Assert outside the provider callback: transports deliberately catch
        // probe failures, so assertions here alone could produce a false pass.
        if (stateDuring === "terminating") nestedStatus = (await observe()).status;
      } finally { releaseTermination(); await stopping; }
    };
    expect((await observe()).status).toBe("unknown");
    expect(stateDuring).toBe("terminating");
    expect(nestedStatus).toBe("unknown");
    expect(visibleAtFence).toBe(true);
    const beforeRetired = { queries, probes };
    expect((await observe()).status).toBe("unknown");
    expect({ queries, probes }).toEqual(beforeRetired);
    expect(await openClients()[provider].observeTermination({ operationId })).toEqual({ status: "terminated" });
    expect((await persistence.journal().read(operationId))?.state).toBe("terminated");
    expect({ creates, terminations }).toEqual({ creates: 1, terminations: 1 });
    return;
  }
  if (finish === "deadline") {
    duringProbe = async () => { await Bun.sleep(Math.max(0, intent.providerDeadlineEpochMs - Date.now() + 2)); };
    expect((await observe()).status).toBe("unknown");
    const beforeExpired = { queries, probes };
    expect((await observe()).status).toBe("unknown");
    expect({ queries, probes }).toEqual(beforeExpired);
    expect(creates).toBe(1);
    return;
  }
  // A concurrent durable retirement during the probe invalidates readiness.
  duringProbe = async () => {
    const record = await persistence.journal().read(operationId);
    if (!record) throw new Error("ORIGINAL_REQUIRED");
    await persistence.journal().update({ operationId, requestSha256: record.requestSha256, state: "terminating" });
  };
  expect((await observe()).status).toBe("unknown");
  const beforeRetired = { queries, probes };
  expect((await observe()).status).toBe("unknown");
  expect({ queries, probes }).toEqual(beforeRetired);
  expect(creates).toBe(1);
}
