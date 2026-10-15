import { NostrClientTransport } from "@contextvm/sdk/transport";
import { PrivateKeySigner } from "@contextvm/sdk/signer";

type JsonRpcResponse = { id: string | number | null; result?: unknown; error?: { message?: string } };
type PaymentTag = readonly [string, string, string?];
export type DevelopmentBootstrap = Readonly<{ relayUrl: string; servicePubkey: string; reserveSat: string; actionCeilingSat: string }>;

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
  #signer?: PrivateKeySigner;
  #nextId = 0;
  #pending = new Map<string | number, { resolve(value: unknown): void; reject(reason: Error): void }>();
  #lastCashu?: Readonly<{ arguments: Record<string, string>; token: string }>;

  constructor(readonly bootstrap: DevelopmentBootstrap) {}

  get pubkey(): Promise<string> {
    if (!this.#signer) throw new Error("CONTEXTVM_NOT_CONNECTED");
    return this.#signer.getPublicKey();
  }

  async connect(): Promise<Readonly<{ pubkey: string; account: any }>> {
    if (this.#client) return { pubkey: await this.pubkey, account: await this.callTool("account_status", {}) };
    this.#signer = new PrivateKeySigner();
    const client = new PaymentTaggedClient({ signer: this.#signer, relayHandler: [this.bootstrap.relayUrl], serverPubkey: this.bootstrap.servicePubkey, encryptionMode: "required", logLevel: "silent" });
    client.setClientPmis(["bitcoin-lightning-bolt11", "bitcoin-cashu-v4-direct"]);
    client.onmessage = (message: any) => {
      if (!message || typeof message !== "object" || !("id" in message)) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      const response = message as JsonRpcResponse;
      if (response.error) pending.reject(new Error(response.error.message ?? "ContextVM request failed"));
      else pending.resolve(response.result);
    };
    await client.start();
    this.#client = client;
    await this.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "napplet-cvm-dev-ui", version: "0.1.0" } });
    await this.call("tools/list", {});
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} } as never);
    return { pubkey: await this.pubkey, account: await this.callTool("account_status", {}) };
  }

  async accountStatus(): Promise<any> { return this.callTool("account_status", {}); }

  async fundCashu(amount: string): Promise<any> {
    const faucet = await fetch(`/dev/faucet/cashu?amount=${encodeURIComponent(amount)}`, { method: "POST" });
    if (!faucet.ok) throw new Error("LOCAL_CASHU_FAUCET_UNAVAILABLE");
    const { token } = await faucet.json() as { token: string };
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

  async close(): Promise<void> { await this.#client?.close(); this.#client = undefined; this.#pending.clear(); }

  private async callTool(name: string, argumentsValue: unknown, tags?: readonly PaymentTag[]): Promise<any> {
    return this.call("tools/call", { name, arguments: argumentsValue }, tags);
  }

  private async call(method: string, params: unknown, tags?: readonly PaymentTag[]): Promise<any> {
    if (!this.#client) throw new Error("CONTEXTVM_NOT_CONNECTED");
    const id = ++this.#nextId;
    if (tags) this.#client.setPaymentTags(id, tags);
    try {
      const response = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error("CONTEXTVM_WIRE_TIMEOUT")); }, 30_000);
        this.#pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
        void this.#client!.send({ jsonrpc: "2.0", id, method, params } as never).catch((error) => {
          clearTimeout(timer); this.#pending.delete(id); reject(error instanceof Error ? error : new Error("CONTEXTVM_SEND_FAILED"));
        });
      });
      return response;
    } finally { this.#client.clearPaymentTags(id); }
  }
}
