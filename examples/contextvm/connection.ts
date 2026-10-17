import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateSecretKey } from "nostr-tools/pure";
import { EncryptionMode } from "@contextvm/sdk/core";
import { PrivateKeySigner } from "@contextvm/sdk/signer";
import { z } from "zod";

/** Run from the repository root, or supply absolute paths. Never use the CVM operator key. */
export async function connectionOptions() {
  const config = z.object({ relayUrl: z.string().url(), servicePubkey: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
    .parse(JSON.parse(await readFile(resolve(process.env.CVM_CONFIG ?? ".local/workspace/cvm.json"), "utf8")));
  if (!["ws:", "wss:"].includes(new URL(config.relayUrl).protocol)) throw new Error("CVM_RELAY_INVALID");
  const keyPath = resolve(process.env.CVM_CLIENT_KEY_FILE ?? ".local/docs-client.key");
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  try { await writeFile(keyPath, Buffer.from(generateSecretKey()).toString("hex"), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if ((await stat(keyPath)).mode & 0o077) throw new Error("CVM_CLIENT_KEY_FILE_MUST_BE_PRIVATE");
  const key = (await readFile(keyPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("CVM_CLIENT_KEY_INVALID");
  return { signer: new PrivateKeySigner(key), relayHandler: [config.relayUrl], serverPubkey: config.servicePubkey, encryptionMode: EncryptionMode.REQUIRED, logLevel: "silent" as const };
}
