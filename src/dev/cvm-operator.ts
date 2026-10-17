import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { z } from "zod";
import type { PostgresSqlClient } from "../persistence/postgres-sql-funding-store";
import { configuredProviderFromEnvironment } from "./development-model-gateway";
import { PriceCardSchema, ModelProfileSchema, RationalRateSchema } from "../model/price-card";
import { listOperatorJobs, readOperatorJob } from "./operator-jobs";
import { safeChatGptError } from "./chatgpt-oauth";
import { KrakenQuoteReader } from "../currency/kraken-quote";

const Id = z.string().min(1).max(240);
export const OperatorRates = z.object({ input_tokens: RationalRateSchema, output_tokens: RationalRateSchema, cached_tokens: RationalRateSchema, reasoning_tokens: RationalRateSchema }).strict();
const ModelRates = z.record(z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/u), OperatorRates).refine(value => Object.keys(value).length <= 128);
const ApiAccount = z.object({ id: z.string().uuid(), label: z.string().min(1).max(80), apiKey: z.string().min(1).max(4096), model: z.string().min(1).max(128), profile: ModelProfileSchema, priceCard: PriceCardSchema, priceSources: z.unknown() }).strict();
const State = z.object({ version: z.literal(1), adminKey: z.string().regex(/^[a-f0-9]{64}$/u), apiAccounts: z.array(ApiAccount).max(16), selectedApi: z.string().uuid().optional(), rates: OperatorRates.optional(), modelRates: ModelRates.optional() }).strict();
export const CvmAdminArgumentsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("exchange_rate") }).strict(),
  z.object({ action: z.literal("chatgpt"), operation: z.enum(["status", "sign-in", "models", "select", "welcome", "logout"]), body: z.unknown().optional() }).strict(),
  z.object({ action: z.literal("save_rates"), rates: OperatorRates }).strict(),
  z.object({ action: z.literal("save_model_rates"), modelRates: ModelRates }).strict(),
  z.object({ action: z.literal("add_api"), account: ApiAccount }).strict(),
  z.object({ action: z.literal("select_api"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("remove_api"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("jobs"), status: z.enum(["all", "pending", "active", "review", "finished"]).default("all"), search: z.string().trim().max(160).default(""), offset: z.number().int().min(0).max(100000).default(0) }).strict(),
  z.object({ action: z.literal("check_receipt"), id: Id }).strict(),
  z.object({ action: z.literal("job"), id: Id, kind: z.enum(["action", "pending"]) }).strict(),
]);
type OperatorOptions = { checkReceipt?(id: string): Promise<unknown>; pool: Pick<PostgresSqlClient, "query">; busy(): boolean; pricing(): { card: unknown; profile: unknown }; configure(): Promise<void>; chatgpt(operation: string, body: unknown): Promise<unknown> };

/** CVM-local vault. Only a signed request from the allowlisted operator can read
 * redacted configuration or jobs. Secret fields have no read operation. */
export class CvmOperator {
  readonly exchangeRates = new KrakenQuoteReader();
  #state: z.infer<typeof State>;
  #tail: Promise<unknown> = Promise.resolve();
  readonly pubkey: string;
  private constructor(private readonly path: string, state: z.infer<typeof State>, private readonly options: OperatorOptions) {
    this.#state = state; this.pubkey = getPublicKey(Uint8Array.from(Buffer.from(state.adminKey, "hex")));
  }
  static async open(directory: string, options: OperatorOptions) {
    await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    const path = resolve(directory, "operator.json"); let state: z.infer<typeof State>;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 2_000_000) throw new Error("OPERATOR_PRIVATE_STORAGE_INVALID");
      state = State.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as any).code !== "ENOENT") throw error;
      state = { version: 1, adminKey: Buffer.from(generateSecretKey()).toString("hex"), apiAccounts: [] };
      await writeFile(path, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    }
    return new CvmOperator(path, state, options);
  }
  async clearApiSelection() { if (this.#state.selectedApi) { this.#state.selectedApi = undefined; await this.#save(); } }
  rates(model?: string) { const rates = model ? this.#state.modelRates?.[model] ?? this.#state.rates : this.#state.rates; return rates && structuredClone(rates); }
  selectedApi() { const account = this.#state.apiAccounts.find(a => a.id === this.#state.selectedApi); return account && structuredClone(account); }
  async #save() {
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(State.parse(this.#state)), { mode: 0o600, flag: "wx" }); await rename(temporary, this.path);
  }
  async handle(input: unknown, principal: string): Promise<unknown> {
    if (principal !== this.pubkey) return { status: "denied", code: "OPERATOR_REQUIRED" };
    const parsed = CvmAdminArgumentsSchema.safeParse(input);
    if (!parsed.success) return { status: "rejected", code: "INVALID_ADMIN_COMMAND" };
    const command = parsed.data;
    const run = async () => {
      try {
        if (command.action === "exchange_rate") return { status: "ok", exchangeRate: await this.exchangeRates.read() };
        if (command.action === "status") return { status: "ok", pricing: this.options.pricing(), rates: this.rates(), modelRates: structuredClone(this.#state.modelRates ?? {}), selectedApi: this.#state.selectedApi, apiAccounts: this.#state.apiAccounts.map(a => ({ id: a.id, label: a.label, model: a.model, keyConfigured: true })), busy: this.options.busy() };
        if (command.action === "jobs") return { status: "ok", ...await listOperatorJobs(this.options.pool, command.status, command.offset, command.search) };
        if (command.action === "job") return { status: "ok", job: await readOperatorJob(this.options.pool, command.id, command.kind) };
        if (command.action === "check_receipt") return { status: "ok", recovery: await this.options.checkReceipt?.(command.id) ?? { outcome: "unavailable" } };
        if (command.action === "chatgpt") {
          const result = await this.options.chatgpt(command.operation, command.body ?? {});
          return result;
        }
        if (this.options.busy()) return { status: "rejected", code: "CONFIGURATION_BUSY" };
        const previous = structuredClone(this.#state);
        try {
          if (command.action === "save_rates") {
            if (this.#state.selectedApi) return { status: "rejected", code: "API_RATES_REQUIRE_NEW_PRICE_EVIDENCE" };
            const profile = ModelProfileSchema.parse(this.options.pricing().profile);
            if (profile.provider === "openai_chatgpt_development") this.#state.modelRates = { ...this.#state.modelRates, [profile.model]: command.rates };
            else this.#state.rates = command.rates;
          }
          if (command.action === "save_model_rates") this.#state.modelRates = ModelRates.parse({ ...this.#state.modelRates, ...command.modelRates });
          if (command.action === "add_api") {
            await configuredProviderFromEnvironment(command.account);
            const existing = this.#state.apiAccounts.find(a => a.id === command.account.id);
            if (existing) return JSON.stringify(existing) === JSON.stringify(command.account) ? { status: "ok" } : { status: "rejected", code: "API_ACCOUNT_ID_CONFLICT" };
            if (this.#state.apiAccounts.length >= 16) throw new Error("API_ACCOUNT_LIMIT");
            this.#state.apiAccounts.push(command.account);
          }
          if (command.action === "select_api") {
            if (!this.#state.apiAccounts.some(a => a.id === command.id)) throw new Error("API_ACCOUNT_MISSING");
            this.#state.selectedApi = command.id;
          }
          if (command.action === "remove_api") {
            if (this.#state.selectedApi === command.id) return { status: "rejected", code: "ACTIVE_API_ACCOUNT" };
            this.#state.apiAccounts = this.#state.apiAccounts.filter(a => a.id !== command.id);
          }
          await this.options.configure(); await this.#save(); return { status: "ok" };
        } catch (error) { this.#state = previous; await this.options.configure(); throw error; }
      } catch (error) {
        // Validation and remote bodies can contain secrets; never echo them.
        return { status: "rejected", code: safeChatGptError(error) === "CHATGPT_REQUEST_FAILED" ? "ADMIN_OPERATION_REJECTED" : safeChatGptError(error) };
      }
    };
    // Read-only job/status views remain responsive while OAuth/provider calls run.
    if (["status", "jobs", "job", "exchange_rate"].includes(command.action)) return run();
    const result = this.#tail.then(run); this.#tail = result.catch(() => undefined); return result;
  }
}
