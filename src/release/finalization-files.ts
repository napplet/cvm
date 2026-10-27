import { link, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson } from "../promotion/schema";

/** Publish complete, synced bytes atomically without replacing an existing
 * original-operation claim. A racing reader never sees a partial JSON file. */
export async function claimFinalizationRecord(path: string, value: unknown): Promise<boolean> {
  const text = `${canonicalJson(value)}\n`;
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  try {
    try { await link(temporary, path); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST") || await readFile(path, "utf8") !== text) throw new Error("RELEASE_FINALIZATION_RECORD_COLLISION");
      return false;
    }
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  } finally { await unlink(temporary); }
}
