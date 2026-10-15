import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

type PendingActionKey = Readonly<{ keyId: string; key: Uint8Array }>;
const loading = new Map<string, Promise<PendingActionKey>>();
const missing = (error: unknown) => (error as { code?: string }).code === "ENOENT";

async function readPrivateFile(path: string, maximum: number): Promise<Uint8Array | undefined> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (missing(error)) return undefined; throw new Error("DEV_PENDING_KEY_FILE_UNREADABLE"); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("DEV_PENDING_KEY_FILE_INVALID");
    const bytes = Buffer.alloc(stat.size + 1); const result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== stat.size) throw new Error("DEV_PENDING_KEY_FILE_CHANGED");
    return bytes.subarray(0, result.bytesRead);
  } finally { await handle.close(); }
}

/** Install complete private bytes exactly once, even across concurrent processes. */
async function createOnce(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await link(temporary, path); }
    catch (error) { if ((error as { code?: string }).code !== "EEXIST") throw error; }
  } finally { await rm(temporary, { force: true }); }
}

/** Server-only development checkpoint key authority; no key enters projections. */
export class LocalCheckpointStore {
  readonly #root: string;
  constructor(input: Readonly<{ root?: string }> = {}) { this.#root = resolve(input.root ?? join(import.meta.dir, "../../.local/development-checkpoints")); }

  async loadOrCreatePendingActionKey(): Promise<PendingActionKey> {
    let pending = loading.get(this.#root);
    if (!pending) {
      pending = this.load().finally(() => loading.delete(this.#root));
      loading.set(this.#root, pending);
    }
    const loaded = await pending;
    return Object.freeze({ keyId: loaded.keyId, key: new Uint8Array(loaded.key) });
  }

  private async load(): Promise<PendingActionKey> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.#root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) throw new Error("DEV_PENDING_KEY_DIRECTORY_NOT_PRIVATE");
    const keyPath = join(this.#root, "pending-action.key"); const identityPath = join(this.#root, "pending-action-key.json");
    let identity = await readPrivateFile(identityPath, 512);
    let key = await readPrivateFile(keyPath, 32);
    if (!key && identity) throw new Error("DEV_PENDING_KEY_MISSING");
    if (!key) {
      await createOnce(keyPath, crypto.getRandomValues(new Uint8Array(32)));
      key = await readPrivateFile(keyPath, 32);
    }
    if (!key || key.byteLength !== 32) throw new Error("DEV_PENDING_KEY_INVALID");
    const keyId = `dev-pending:${new Bun.CryptoHasher("sha256").update(key).digest("hex")}`;
    if (!identity) {
      await createOnce(identityPath, new TextEncoder().encode(JSON.stringify({ version: 1, keyId })));
      identity = await readPrivateFile(identityPath, 512);
    }
    let parsed: { version?: unknown; keyId?: unknown };
    try { parsed = JSON.parse(new TextDecoder().decode(identity)); } catch { throw new Error("DEV_PENDING_KEY_IDENTITY_INVALID"); }
    if (!parsed || Object.keys(parsed).length !== 2 || parsed.version !== 1 || parsed.keyId !== keyId) throw new Error("DEV_PENDING_KEY_IDENTITY_MISMATCH");
    return Object.freeze({ keyId, key });
  }
}
