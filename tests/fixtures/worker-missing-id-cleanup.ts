import { expect } from "bun:test";
import { createFlyMachinesHttpTransport, createModalProductionTransport, PRODUCTION_WORKER_POLICY,
  type WorkerOperationJournal } from "../../src/release/deployment/worker-clients";

const digest = (value: string) => value.repeat(64);
const image = `registry.example/worker@sha256:${digest("a")}`;
const appName = "lost-worker-cleanup";

/** Local native-boundary mechanism checks; never protected release evidence. */
export async function proveModalMissingIdCleanup(journal: () => WorkerOperationJournal) {
  let tags: Record<string, string> = {}, visible = false, creates = 0, deletes = 0, queries = 0;
  let lookup: "exact" | "missing" | "unknown" | "wrong" = "exact";
  const sandbox = { id: "original-lost-sandbox", getTags: async () => lookup === "wrong" ? { ...tags, "napplet-cvm-lease-sha256": digest("f") } : tags,
    exec: async () => { throw new Error("CLEANUP_MUST_NOT_EXECUTE_WORKER"); }, poll: async () => ({}),
    terminate: async () => { deletes++; visible = false; throw new Error("TERMINATION_ACK_LOST"); },
    filesystem: { copyFromLocal: async () => {}, copyToLocal: async () => {}, listFiles: async () => [] } };
  const open = () => createModalProductionTransport({ appName, image, workspaceRoot: "/workspace", tags: { purpose: "cleanup-test" }, journal: journal(),
    sdk: { apps: { fromName: async () => ({}) }, images: { fromRegistry: () => ({}) }, sandboxes: {
      async create(_app, _image, options) { creates++; tags = { ...options.tags }; visible = true; throw new Error("CREATE_ACK_LOST"); },
      async findByName() { queries++; return !visible || lookup === "missing" ? { kind: "missing" as const } : lookup === "unknown" ? { kind: "unknown" as const } : { kind: "found" as const, sandbox }; },
    } } });
  const intent = { operationId: "lost-modal-cleanup", sessionLeaseSha256: digest("b"), toolchainSha256: digest("c"), providerDeadlineEpochMs: Date.now() + 100 };
  expect((await open().create(intent)).status).toBe("unknown");
  const retained = await journal().read(intent.operationId);
  if (!retained) throw new Error("ORIGINAL_REQUIRED");
  expect(retained.resourceId).toBeUndefined();
  const { state: _state, resourceId: _resourceId, ...facts } = retained;
  const unstarted = { operationId: "unstarted-modal-cleanup" };
  await journal().claim({ ...facts, ...unstarted });
  const beforeUnstarted = queries;
  expect(await open().observeTermination(unstarted)).toEqual({ status: "unknown" });
  expect(await open().terminate(unstarted)).toEqual({ status: "unknown" });
  expect(queries).toBe(beforeUnstarted);
  await Bun.sleep(Math.max(0, intent.providerDeadlineEpochMs - Date.now() + 2));
  await expect(open().create(intent)).rejects.toThrow("WORKER_DEADLINE_INVALID");
  const beforeExpiredReadiness = queries;
  expect((await open().observe(intent)).status).toBe("unknown");
  expect(queries).toBe(beforeExpiredReadiness);
  for (const mode of ["missing", "unknown", "wrong"] as const) {
    lookup = mode;
    expect((await open().observeTermination(intent)).status).toBe("unknown");
    expect((await open().terminate(intent)).status).toBe("unknown");
    expect((await journal().read(intent.operationId))?.resourceId).toBeUndefined();
    expect({ creates, deletes }).toEqual({ creates: 1, deletes: 0 });
  }
  lookup = "exact";
  expect(await open().observeTermination(intent)).toEqual({ status: "pending" });
  expect(await journal().read(intent.operationId)).toMatchObject({ resourceId: sandbox.id, state: "reconciled" });
  expect({ creates, deletes }).toEqual({ creates: 1, deletes: 0 });
  expect(await open().terminate(intent)).toEqual({ status: "pending" });
  expect(await open().observeTermination(intent)).toEqual({ status: "terminated" });
  expect(await open().terminate(intent)).toEqual({ status: "terminated" });
  expect({ creates, deletes }).toEqual({ creates: 1, deletes: 1 });
}

export async function proveFlyMissingIdCleanup(journal: () => WorkerOperationJournal) {
  let body: Record<string, unknown> = {}, visible = false, creates = 0, deletes = 0, queries = 0;
  let lookup: "exact" | "missing" | "unknown" | "wrong" | "duplicate" | "region" | "late" = "exact";
  const machine = () => ({ ...body, id: "original-lost-machine", created_at: new Date().toISOString() });
  // Keep the provider creation identity immutable across every list/GET.
  let original: ReturnType<typeof machine> | undefined;
  const open = () => createFlyMachinesHttpTransport({ appName, journal: journal(), getAccessToken: async () => "local-provider-fixture-token",
    async fetch(url, init) {
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://api.machines.dev");
      if (init.method === "POST") {
        creates++; body = JSON.parse(String(init.body)); original = machine(); visible = true; throw new Error("CREATE_ACK_LOST");
      }
      if (init.method === "DELETE") { deletes++; visible = false; throw new Error("TERMINATION_ACK_LOST"); }
      if (init.method !== "GET") throw new Error("UNEXPECTED_PROVIDER_MUTATION");
      queries++;
      if (parsed.searchParams.has("metadata.napplet-cvm-operation")) {
        if (lookup === "unknown") return new Response("unavailable", { status: 503 });
        if (!visible || lookup === "missing") return Response.json([]);
        const observed = lookup === "wrong" ? { ...original, config: { image: `registry.example/foreign@sha256:${digest("f")}` } }
          : lookup === "region" ? { ...original, region: "iad" }
          : lookup === "late" ? { ...original, created_at: new Date(intent.providerDeadlineEpochMs + 1).toISOString() } : original;
        return Response.json(lookup === "duplicate" ? [observed, observed] : [observed]);
      }
      return visible ? Response.json(original) : new Response(null, { status: 404 });
    } });
  const intent = { operationId: "lost-fly-cleanup", region: "ams", image, policy: PRODUCTION_WORKER_POLICY,
    sessionLeaseSha256: digest("b"), toolchainSha256: digest("c"), providerDeadlineEpochMs: Date.now() + 100 };
  expect((await open().create(intent)).status).toBe("unknown");
  const retained = await journal().read(intent.operationId);
  if (!retained) throw new Error("ORIGINAL_REQUIRED");
  expect(retained.resourceId).toBeUndefined();
  const { state: _state, resourceId: _resourceId, ...facts } = retained;
  const unstarted = { operationId: "unstarted-fly-cleanup" };
  await journal().claim({ ...facts, ...unstarted });
  const beforeUnstarted = queries;
  expect(await open().observeTermination(unstarted)).toEqual({ status: "unknown" });
  expect(await open().terminate(unstarted)).toEqual({ status: "unknown" });
  expect(queries).toBe(beforeUnstarted);
  await Bun.sleep(Math.max(0, intent.providerDeadlineEpochMs - Date.now() + 2));
  await expect(open().create(intent)).rejects.toThrow("WORKER_DEADLINE_INVALID");
  const beforeExpiredReadiness = queries;
  expect((await open().observe(intent)).status).toBe("unknown");
  expect(queries).toBe(beforeExpiredReadiness);
  for (const mode of ["missing", "unknown", "wrong", "duplicate", "region", "late"] as const) {
    lookup = mode;
    expect((await open().observeTermination(intent)).status).toBe("unknown");
    expect((await open().terminate(intent)).status).toBe("unknown");
    expect((await journal().read(intent.operationId))?.resourceId).toBeUndefined();
    expect({ creates, deletes }).toEqual({ creates: 1, deletes: 0 });
  }
  lookup = "exact";
  expect(await open().observeTermination(intent)).toEqual({ status: "pending" });
  expect(await journal().read(intent.operationId)).toMatchObject({ resourceId: "original-lost-machine", state: "reconciled", providerCreatedAtMs: Date.parse(original!.created_at) });
  expect({ creates, deletes }).toEqual({ creates: 1, deletes: 0 });
  await expect(open().terminate(intent)).rejects.toThrow("TERMINATION_ACK_LOST");
  expect(await open().observeTermination(intent)).toEqual({ status: "terminated" });
  expect(await open().terminate(intent)).toEqual({ status: "terminated" });
  expect({ creates, deletes }).toEqual({ creates: 1, deletes: 1 });
}
