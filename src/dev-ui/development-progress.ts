import { AsyncLocalStorage } from "node:async_hooks";
import type { ContextVmTransportPort, ContextVmInboundEnvelope } from "../contextvm/sdk-bridge";
import type { ModelGateway } from "../model/model-gateway";
import { DevelopmentProgressSchema, progressMethod, progressTools, type DevelopmentProgress, type ProgressStage, type ProgressState } from "./progress-contract";

type Scope = { input: ContextVmInboundEnvelope; progressId: string | number; tool: DevelopmentProgress["tool"]; started: number; sequence: number; active: boolean; stage: ProgressStage; state: ProgressState; queue: Promise<void>; queued: number };
type Details = Pick<DevelopmentProgress, "bytes" | "provider" | "model" | "diagnostic">;

/** Development-only, best-effort observations. Async scope is bound to the
 * authenticated envelope, never caller-supplied pubkeys or session IDs. */
export class DevelopmentProgressTransport implements ContextVmTransportPort {
  readonly #scope = new AsyncLocalStorage<Scope>();
  constructor(private readonly transport: ContextVmTransportPort, private readonly timing = { heartbeatMs: 5000, sendTimeoutMs: 1000 }) {}
  configureAnnouncement: ContextVmTransportPort["configureAnnouncement"] = (...args) => this.transport.configureAnnouncement(...args);
  canonicalInvocation: ContextVmTransportPort["canonicalInvocation"] = (...args) => this.transport.canonicalInvocation(...args);
  sendNotification: ContextVmTransportPort["sendNotification"] = (...args) => this.transport.sendNotification(...args);
  sendResponse: ContextVmTransportPort["sendResponse"] = async (...args) => {
    const scope = this.#scope.getStore();
    if (scope) { scope.active = false; await this.bounded(scope.queue); }
    await this.transport.sendResponse(...args);
  };
  onInbound(handler: (input: ContextVmInboundEnvelope) => Promise<void>): void {
    this.transport.onInbound(async (input) => {
      const tool = (input.request.params as { name?: unknown } | null)?.name;
      if (input.request.method !== "tools/call" || !progressTools.includes(tool as never) || input.request.id === null) return handler(input);
      // The SDK rewrites RPC IDs to Nostr event IDs on the server. MCP's
      // progress token preserves browser correlation without granting authority.
      const token = (input.request.params as { _meta?: { progressToken?: unknown } })?._meta?.progressToken;
      const progressId = typeof token === "string" && token.length > 0 && token.length <= 128 ? token : input.request.id;
      const scope: Scope = { input, progressId, tool: tool as Scope["tool"], started: performance.now(), sequence: 0, active: true, stage: "request", state: "running", queue: Promise.resolve(), queued: 0 };
      return this.#scope.run(scope, async () => {
        this.emit("request", "running");
        const timer = setInterval(() => this.emit(scope.stage, scope.state, {}, "heartbeat"), this.timing.heartbeatMs);
        try { await handler(input); } finally { clearInterval(timer); scope.active = false; }
      });
    });
  }
  emit(stage: ProgressStage, state: ProgressState, details: Details = {}, kind: DevelopmentProgress["kind"] = "stage"): void {
    const scope = this.#scope.getStore();
    if (!scope?.active || scope.queued >= 32 || scope.sequence >= 1000) return;
    // Re-validate the entire projection: no arbitrary error text, source or logs.
    const parsed = DevelopmentProgressSchema.safeParse({ version: 1, requestId: scope.progressId, tool: scope.tool, sequence: scope.sequence + 1, at: Date.now(), elapsedMs: Math.floor(performance.now() - scope.started), kind, stage, state, ...details });
    if (!parsed.success) return;
    scope.sequence++; scope.stage = stage; scope.state = state; scope.queued++;
    scope.queue = scope.queue.then(async () => {
      await this.bounded(Promise.resolve().then(() => this.transport.sendNotification(scope.input.verifiedClientPubkey, { jsonrpc: "2.0", method: progressMethod, params: parsed.data }, scope.input.requestEventId)));
    }).finally(() => { scope.queued--; });
  }
  gateway(gateway: ModelGateway, metadata: Omit<Details, "provider"> & { provider?: unknown }): ModelGateway {
    // Display labels never expand the public notification contract or affect
    // the provider operation. Omit unsupported labels, retain bounded facts.
    const { provider, ...rest } = metadata;
    const parsedProvider = DevelopmentProgressSchema.shape.provider.safeParse(provider);
    const details: Details = { ...rest, ...(parsedProvider.success && parsedProvider.data !== undefined ? { provider: parsedProvider.data } : {}) };
    return {
      dispatch: async (...args) => {
        this.emit("model", "running", details);
        try {
          const result = await gateway.dispatch(...args);
          this.emit("model", result.status === "completed" ? "completed" : result.status === "usage_unknown" ? "uncertain" : "failed", details);
          if (result.status === "completed" && result.sourceProposalReference) this.emit("model_recorded", "completed");
          return result;
        } catch (error) { this.emit("model", "failed"); throw error; }
      },
      lookup: async (...args) => {
        this.emit("model", "running", details);
        try {
          const result = await gateway.lookup(...args);
          this.emit("model", result.status === "receipt_found" ? "completed" : result.status === "definitive_not_accepted" ? "failed" : "uncertain", details);
          return result;
        } catch (error) { this.emit("model", "failed"); throw error; }
      },
    };
  }
  private async bounded(work: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, this.timing.sendTimeoutMs); })]); }
    catch { /* Observability cannot change a financial or execution result. */ }
    finally { clearTimeout(timer); }
  }
}
