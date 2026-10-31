import { z } from "zod";

const Uuid = z.string().uuid();
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const Origin = z.string().url().refine(value => new URL(value).protocol === "https:", "Coolify origin must use https");
const Resource = z.object({ uuid: Uuid, status: z.string().min(1).optional(), image: z.string().optional(), destination_id: z.string().optional() }).passthrough();

export const NonGoogleCoolifyReferenceSchema = z.object({
  baseOrigin: Origin,
  serverUuid: Uuid,
  projectUuid: Uuid,
  environmentUuid: Uuid,
  postgres17Image: Digest,
  restorerImage: Digest,
  namePrefix: z.string().min(1).max(48).regex(/^[a-z0-9-]+$/u),
  tokenPath: z.string().min(1).refine(value => value.startsWith("/")),
}).strict();
export type NonGoogleCoolifyReference = z.infer<typeof NonGoogleCoolifyReferenceSchema>;
export type NonGoogleCoolifyResource = Readonly<{ uuid: string; status?: string; image?: string; destinationId?: string }>;
export type NonGoogleCoolifyHttp = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const boundedJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.length > 64 * 1024) throw new Error("NON_GOOGLE_COOLIFY_RESPONSE_TOO_LARGE");
  try { return text.length === 0 ? {} : JSON.parse(text) as unknown; }
  catch { throw new Error("NON_GOOGLE_COOLIFY_RESPONSE_INVALID"); }
};

/** A documented self-hosted Coolify /api/v1 driver. Tokens are resolved only
 * inside an operation; construction is inert. */
export class NonGoogleCoolifyDriver {
  readonly reference: NonGoogleCoolifyReference;
  constructor(
    reference: NonGoogleCoolifyReference,
    private readonly http: NonGoogleCoolifyHttp = fetch,
    private readonly readToken: (path: string) => Promise<string> = async () => { throw new Error("NON_GOOGLE_COOLIFY_TOKEN_RESOLVER_REQUIRED"); },
  ) { this.reference = Object.freeze(NonGoogleCoolifyReferenceSchema.parse(reference)); Object.freeze(this); }

  async createPostgres(operationName: string): Promise<NonGoogleCoolifyResource> {
    return this.#resource("POST", "/databases/postgresql", {
      server_uuid: this.reference.serverUuid, project_uuid: this.reference.projectUuid,
      environment_uuid: this.reference.environmentUuid, name: this.#name(operationName),
      image: `postgres@${this.reference.postgres17Image}`,
      instant_deploy: true,
    });
  }
  async createRestorer(operationName: string, dockerfile: string): Promise<NonGoogleCoolifyResource> {
    if (!dockerfile.includes(this.reference.restorerImage)) throw new Error("NON_GOOGLE_RESTORER_IMAGE_MISMATCH");
    return this.#resource("POST", "/applications/dockerfile", {
      server_uuid: this.reference.serverUuid, project_uuid: this.reference.projectUuid,
      environment_uuid: this.reference.environmentUuid, name: this.#name(operationName), dockerfile,
      instant_deploy: true, autogenerate_domain: false, health_check_enabled: false,
    });
  }
  getDatabase(uuid: string) { return this.#resource("GET", `/databases/${Uuid.parse(uuid)}`); }
  getApplication(uuid: string) { return this.#resource("GET", `/applications/${Uuid.parse(uuid)}`); }
  startApplication(uuid: string) { return this.#resource("POST", `/applications/${Uuid.parse(uuid)}/start`, {}); }
  stopApplication(uuid: string) { return this.#resource("POST", `/applications/${Uuid.parse(uuid)}/stop`, {}); }
  async deleteDatabase(uuid: string): Promise<void> { await this.#request("DELETE", `/databases/${Uuid.parse(uuid)}`); }
  async deleteApplication(uuid: string): Promise<void> { await this.#request("DELETE", `/applications/${Uuid.parse(uuid)}`); }

  #name(operationName: string) { return `${this.reference.namePrefix}-${z.string().min(1).max(80).regex(/^[a-z0-9-]+$/u).parse(operationName)}`; }
  async #resource(method: string, path: string, body?: unknown): Promise<NonGoogleCoolifyResource> {
    const payload = Resource.parse(await this.#request(method, path, body));
    return Object.freeze({ uuid: payload.uuid, status: payload.status, image: payload.image, destinationId: payload.destination_id });
  }
  async #request(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = (await this.readToken(this.reference.tokenPath)).trim();
    if (token.length === 0) throw new Error("NON_GOOGLE_COOLIFY_TOKEN_EMPTY");
    const response = await this.http(new URL(`/api/v1${path}`, this.reference.baseOrigin), {
      method, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`NON_GOOGLE_COOLIFY_HTTP_${response.status}`);
    return boundedJson(response);
  }
}
