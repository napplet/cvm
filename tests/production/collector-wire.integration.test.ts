import { describe, expect, test } from "bun:test";
import { assertCollectorAccepted, collectorLifecyclePackets, parseCollectorLifecycleWindow } from "../../src/production/collector-wire";
import { LifecycleStageSchema } from "../../src/telemetry/contracts";

const windowSha256 = "a".repeat(64);
const packets = LifecycleStageSchema.options.map((stage, index) => collectorLifecyclePackets({
  operationId: `collector-mechanism:${index}`, windowSha256, nowMs: Date.now(),
  observation: { version: "admission-lifecycle-v1", correlationDigest: `sha256:${"b".repeat(64)}`, stage, outcome: "succeeded", monotonicMs: index + 1 },
}));

async function docker(args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Docker ${args[0]} failed: ${stderr.slice(-4000)}`);
  return `${stdout}\n${stderr}`;
}

describe("collector lifecycle wire boundary", () => {
  test("rejects free text and keeps correlation out of metric labels", () => {
    expect(() => collectorLifecyclePackets({ operationId: "canary", windowSha256, nowMs: 1, observation: { ...packets[0]!.observation, prompt: "private" } })).toThrow();
    expect(() => collectorLifecyclePackets({ operationId: "canary", windowSha256, nowMs: 1, observation: { ...packets[0]!.observation, stage: "private" } })).toThrow();
    expect(() => collectorLifecyclePackets({ operationId: "canary", windowSha256, nowMs: 1, observation: { ...packets[0]!.observation, correlationDigest: "private" } })).toThrow();
    assertCollectorAccepted({ partialSuccess: {} });
    expect(() => assertCollectorAccepted({ partialSuccess: { rejectedSpans: "1" } })).toThrow();
    expect(() => assertCollectorAccepted({ partialSuccess: { errorMessage: "warning" } })).toThrow();
    for (const packet of packets) {
      const labels = packet.metrics.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.sum.dataPoints[0]!.attributes.map(value => value.key).sort();
      expect(labels).toEqual(["cvm.lifecycle.outcome", "cvm.lifecycle.stage", "cvm.lifecycle.version"]);
    }
  });

  test.skipIf(process.env.NAPPLET_RUN_COLLECTOR_INTEGRATION !== "1")("actual pinned collector exports all finite stages as structured JSON", async () => {
    const name = `cvm-collector-wire-${process.pid}-${Date.now()}`;
    const tag = `${name}:test`;
    let started = false;
    try {
      await docker(["build", "-f", "infra/production/collector.Dockerfile", "-t", tag, "."]);
      await docker(["run", "-d", "--name", name, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=128m", "--cpus=1", "-p", "127.0.0.1::4318", tag]);
      started = true;
      const address = (await docker(["port", name, "4318/tcp"])).trim();
      const endpoint = `http://${address}`;
      for (let attempt = 0; ; attempt++) {
        try { await fetch(endpoint, { signal: AbortSignal.timeout(500) }); break; }
        catch (error) { if (attempt === 30) throw error; await Bun.sleep(100); }
      }
      for (const packet of packets) for (const signal of ["traces", "metrics"] as const) {
        const response = await fetch(`${endpoint}/v1/${signal}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(packet[signal]), signal: AbortSignal.timeout(2000) });
        expect(response.status).toBe(200);
        assertCollectorAccepted(await response.json());
      }
      let entries: unknown[] = [];
      let result: ReturnType<typeof parseCollectorLifecycleWindow> | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        entries = (await docker(["logs", name])).split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
        try { result = parseCollectorLifecycleWindow({ windowSha256, expected: packets, entries }); break; }
        catch (error) { if (attempt === 49) throw error; await Bun.sleep(100); }
      }
      expect(result!.observations.map(value => value.stage).sort()).toEqual([...LifecycleStageSchema.options].sort());
      expect(result!.metricSeriesCount).toBe(15);
      expect(() => parseCollectorLifecycleWindow({ windowSha256: "c".repeat(64), expected: packets, entries })).toThrow("COLLECTOR_WINDOW_INCOMPLETE");
      expect(() => parseCollectorLifecycleWindow({ windowSha256, expected: packets, entries: entries.filter((entry: any) => entry["otelcol.signal"] !== "metrics") })).toThrow("COLLECTOR_WINDOW_INCOMPLETE");
      const mutated = entries.map((entry: any) => entry["otelcol.signal"] === "metrics" && entry.msg.startsWith("ResourceMetrics #") ? { ...entry, msg: entry.msg.replace("Data point attributes:\n", "Data point attributes:\n     -> private.prompt: Str(secret)\n") } : entry);
      expect(() => parseCollectorLifecycleWindow({ windowSha256, expected: packets, entries: mutated })).toThrow("COLLECTOR_EXPORTED_ATTRIBUTE_INVALID");
    } finally {
      if (started) await docker(["rm", "-f", name]);
      await docker(["image", "rm", tag]).catch(() => undefined);
    }
  }, 120_000);
});
