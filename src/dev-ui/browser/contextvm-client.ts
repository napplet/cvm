import { NostrClientTransport } from "@contextvm/sdk/transport";
import { PrivateKeySigner } from "@contextvm/sdk/signer";
import type { NostrSigner } from "@contextvm/sdk/core";
export type ContextVmSigner = NostrSigner & { release?(): void };
import { acceptDevelopmentProgress, progressMethod, progressTools, type DevelopmentProgress } from "../progress-contract";

export type ClientActivity = { kind: "sent"; requestId: string | number; tool: string } | { kind: "progress"; progress: DevelopmentProgress } | { kind: "response"; requestId: string | number; tool: string };

type JsonRpcResponse = { id: string | number | null; result?: unknown; error?: { message?: string } };
type PaymentTag = readonly [string, string, string?];
export type DevelopmentBootstrap = Readonly<{ relayUrl: string; servicePubkey: string; reserveSat: string; actionCeilingSat: string; providerLabel: string }>;

export function browserSignerKey(servicePubkey: string): string {
  const storageKey = `napplet-cvm/dev-contextvm-key/v1/${servicePubkey}`;
  const stored = sessionStorage.getItem(storageKey);
  if (stored && /^[a-f0-9]{64}$/u.test(stored)) return stored;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const generated = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  sessionStorage.setItem(storageKey, generated);
  return generated;
}

class PaymentTaggedClient extends NostrClientTransport {
  #requestTags = new Map<string | number, readonly PaymentTag[]>();

  setPaymentTags(id: string | number, tags: readonly PaymentTag[]): void {
    // Tags are immutable and scoped to exactly one outbound request.
    this.#requestTags.set(id, Object.freeze(tags.map((tag) => Object.freeze([...tag]))));
  }

  clearPaymentTags(id: string | number): void { this.#requestTags.delete(id); }

  protected override async sendMcpMessage(message: any, recipient: string, kind: number, tags: string[][] = [], ...rest: any[]): Promise<string> {
    const scoped = typeof message?.id === "string" || typeof message?.id === "number" ? this.#requestTags.get(message.id) : undefined;
    if (!scoped) return super.sendMcpMessage(message, recipient, kind, tags, ...rest);
    const protocolTags = scoped.map((tag) => [...tag] as string[]);
    return super.sendMcpMessage(message, recipient, kind, [...tags.filter((tag) => !["pmi", "payment_interaction", "direct_payment"].includes(tag[0]!)), ...protocolTags], ...rest);
  }
}

export class DevelopmentContextVmClient {
  #client?: PaymentTaggedClient;
  #signer?: ContextVmSigner;
  #nextId = 0;
  #prefix = crypto.randomUUID();
  #pending = new Map<string | number, { tool: string; sequence: number; resolve(value: unknown): void; reject(reason: Error): void }>();
  #lastCashu?: Readonly<{ arguments: Record<string, string>; token: string }>;

  constructor(readonly bootstrap: DevelopmentBootstrap, private readonly onActivity?: (event: ClientActivity) => void, private readonly signingKey?: string | ContextVmSigner) {}
  private activity(event: ClientActivity): void { try { this.onActivity?.(event); } catch { /* UI observation cannot alter a request. */ } }

  get pubkey(): Promise<string> {
    if (!this.#signer) throw new Error("CONTEXTVM_NOT_CONNECTED");
    return this.#signer.getPublicKey();
  }

  async connect(options: { accountStatus?: boolean } = {}): Promise<Readonly<{ pubkey: string; account: any }>> {
    if (this.#client) return { pubkey: await this.pubkey, account: options.accountStatus === false ? undefined : await this.callTool("account_status", {}) };
    // This key remains in the trusted development host's session storage. It
    // never enters bootstrap, ContextVM arguments, logs, or generated preview.
    this.#signer = typeof this.signingKey === "object" ? this.signingKey : new PrivateKeySigner(this.signingKey ?? browserSignerKey(this.bootstrap.servicePubkey));
    const client = new PaymentTaggedClient({ signer: this.#signer, relayHandler: [this.bootstrap.relayUrl], serverPubkey: this.bootstrap.servicePubkey, encryptionMode: "required", logLevel: "silent" });
    client.setClientPmis(["bitcoin-lightning-bolt11", "bitcoin-cashu-v4-direct"]);
    client.onmessage = (message: any) => {
      if (message?.method === progressMethod && !("id" in message)) {
        const pending = this.#pending.get(message.params?.requestId);
        if (!pending) return;
        const progress = acceptDevelopmentProgress(message.params, { id: message.params.requestId, tool: pending.tool, sequence: pending.sequence });
        if (progress) { pending.sequence = progress.sequence; this.activity({ kind: "progress", progress }); }
        return;
      }
      if (!message || typeof message !== "object" || !("id" in message)) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      this.activity({ kind: "response", requestId: message.id, tool: pending.tool });
      const response = message as JsonRpcResponse;
      if (response.error) pending.reject(new Error(response.error.message ?? "ContextVM request failed"));
      else pending.resolve(response.result);
    };
    await client.start();
    this.#client = client;
    await this.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "napplet-cvm-dev-ui", version: "0.1.0" } });
    await this.call("tools/list", {});
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} } as never);
    return { pubkey: await this.pubkey, account: options.accountStatus === false ? undefined : await this.callTool("account_status", {}) };
  }

  async accountStatus(): Promise<any> { return this.callTool("account_status", {}); }

  async fundCashu(amount: string): Promise<any> {
    const { token } = await this.callTool("development_faucet", { amount });
    if (typeof token !== "string") throw new Error("LOCAL_CASHU_FAUCET_UNAVAILABLE");
    const args = { idempotencyKey: `browser:cashu:${crypto.randomUUID()}`, topUpId: `browser:cashu:${crypto.randomUUID()}`, pmi: "bitcoin-cashu-v4-direct", mode: "transparent", amount };
    this.#lastCashu = Object.freeze({ arguments: Object.freeze(args), token });
    return this.callTool("top_up", args, [["pmi", args.pmi], ["payment_interaction", args.mode], ["direct_payment", args.pmi, token]]);
  }

  async replayCashu(): Promise<any> {
    if (!this.#lastCashu) throw new Error("NO_CASHU_ACTION_TO_REPLAY");
    const { arguments: args, token } = this.#lastCashu;
    return this.callTool("top_up", args, [["pmi", args.pmi], ["payment_interaction", args.mode], ["direct_payment", args.pmi, token]]);
  }

  async fundNwc(amount: string): Promise<any> {
    return this.callTool("top_up", { idempotencyKey: `browser:nwc:${crypto.randomUUID()}`, pmi: "bitcoin-lightning-bolt11", mode: "transparent", amount }, [["pmi", "bitcoin-lightning-bolt11"], ["payment_interaction", "transparent"]]);
  }

  async fundAdmission(requestedCap: string, idempotencyKey = `browser:admission:${crypto.randomUUID()}`): Promise<any> {
    return this.callTool("funded_admission", { idempotencyKey, requestedCap, unit: "sat" });
  }

  async startSession(input: Readonly<{ admissionReference: string; maximum: string; idea: string; idempotencyKey?: string }>): Promise<any> {
    return this.callTool("start_session", { admissionReference: input.admissionReference, idempotencyKey: input.idempotencyKey ?? `browser:generation:${crypto.randomUUID()}`, maximum: input.maximum, idea: input.idea });
  }

  async savePreAdmission(input: Readonly<{ maximum: string; idea: string; idempotencyKey: string }>): Promise<any> {
    return this.callTool("start_session", { mode: "pre_admission", idempotencyKey: input.idempotencyKey, maximum: input.maximum, idea: input.idea });
  }

  async pendingActionStatus(checkpointId: string): Promise<any> {
    return this.callTool("session_status", { kind: "pending_action", checkpointId });
  }

  async resumePendingAction(input: Readonly<{ checkpointId: string; idempotencyKey: string; admissionReference: string; reference: string; fingerprint: string; maximum: string }>): Promise<any> {
    return this.callTool("resume_session", {
      kind: "pending_action", checkpointId: input.checkpointId, expectedCheckpointVersion: 1, expectedSessionVersion: 0,
      idempotencyKey: input.idempotencyKey, approvePendingAction: true, admissionReference: input.admissionReference,
      pendingAction: { reference: input.reference, fingerprint: input.fingerprint, kind: "start_session", maximum: input.maximum },
    });
  }

  async sessionStatus(sessionId: string): Promise<any> { return this.callTool("session_status", { sessionId }); }

  async reviseSession(input: Readonly<{ sessionId: string; admissionReference: string; expectedVersion: number; maximum: string; revision: string; idempotencyKey?: string }>): Promise<any> {
    return this.callTool("revise_session", { ...input, idempotencyKey: input.idempotencyKey ?? `browser:revision:${crypto.randomUUID()}` });
  }

  async preview(input: Readonly<{ sessionId: string; artifactId: string }>): Promise<any> {
    return this.callTool("preview", { action: "descriptor", sessionId: input.sessionId, artifactId: input.artifactId, runtimeVariant: "development-paja-0.19.0" });
  }

  async close(): Promise<void> { for (const pending of this.#pending.values()) pending.reject(new Error("CONTEXTVM_CONNECTION_CLOSED")); this.#pending.clear(); try { await this.#client?.close(); } finally { this.#client = undefined; this.#signer?.release?.(); this.#signer = undefined; } }

  async callTool(name: string, argumentsValue: unknown, tags?: readonly PaymentTag[]): Promise<any> {
    // Five-minute model budget + three-minute worker + startup/settlement margin.
    return this.call("tools/call", { name, arguments: argumentsValue }, tags, ["start_session", "revise_session", "resume_session"].includes(name) ? 540_000 : name === "development_publication" || name === "cvm_admin" ? 120_000 : 30_000);
  }

  private async call(method: string, params: unknown, tags?: readonly PaymentTag[], timeoutMs = 30_000): Promise<any> {
    if (!this.#client) throw new Error("CONTEXTVM_NOT_CONNECTED");
    const id = `${this.#prefix}:${++this.#nextId}`;
    const tool = method === "tools/call" ? String((params as { name?: unknown })?.name ?? "") : method;
    if (progressTools.includes(tool as never)) params = { ...(params as object), _meta: { progressToken: id } };
    if (tags) this.#client.setPaymentTags(id, tags);
    try {
      const response = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error("CONTEXTVM_WIRE_TIMEOUT")); }, timeoutMs);
        this.#pending.set(id, { tool, sequence: 0, resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
        if (progressTools.includes(tool as never)) this.activity({ kind: "sent", requestId: id, tool });
        void this.#client!.send({ jsonrpc: "2.0", id, method, params } as never).catch((error) => {
          clearTimeout(timer); this.#pending.delete(id); reject(error instanceof Error ? error : new Error("CONTEXTVM_SEND_FAILED"));
        });
      });
      return response;
    } finally { this.#client?.clearPaymentTags(id); }
  }
}
