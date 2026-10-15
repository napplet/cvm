import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { canonicalJson } from "../promotion/schema";
import { readVerifiedArtifactFile, type VerifiedArtifactFacts } from "./local-artifact-verifier";

export type SealedArtifact = Readonly<{ artifactId: string; ownerId: string; accountId: string; sessionId: string; actionId: string; version: number; proposalSha256: string; toolchainSha256: string; aggregateSha256: string; sealedObjectSha256: string; verificationEvidenceSha256: string; objectKey: string; files: readonly Readonly<{ path: string; sha256: string; bytes: number }>[] }>;
async function sha256(value: string): Promise<string> { return new Bun.CryptoHasher("sha256").update(value).digest("hex"); }

/** Local sealed-object repository. Callers only ever receive an artifact id and file allowlist. */
export class LocalArtifactRepository {
  readonly #artifacts = new Map<string, SealedArtifact>();
  readonly #objectRoot: string;
  constructor(input: Readonly<{ objectRoot: string }>) { this.#objectRoot = resolve(input.objectRoot); }
  async commit(facts: VerifiedArtifactFacts): Promise<SealedArtifact> {
    const artifactId = `artifact:sha256:${await sha256(canonicalJson({ ownerId: facts.ownerId, actionId: facts.actionId, version: facts.expectedVersion, aggregateSha256: facts.aggregateSha256, sealedObjectSha256: facts.sealedObjectSha256 }))}`;
    const existing = this.#artifacts.get(artifactId); if (existing) return existing;
    const objectKey = `sealed/${artifactId.slice("artifact:sha256:".length)}`;
    const destination = this.safeObjectPath(objectKey);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const file of facts.files) {
      const target = this.safeObjectPath(`${objectKey}/${file.path}`);
      await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
      await Bun.write(target, await readVerifiedArtifactFile(facts.distRoot, file));
    }
    const sealed = Object.freeze({ artifactId, ownerId: facts.ownerId, accountId: facts.accountId, sessionId: facts.sessionId, actionId: facts.actionId, version: facts.expectedVersion, proposalSha256: facts.proposalSha256, toolchainSha256: facts.toolchainSha256, aggregateSha256: facts.aggregateSha256, sealedObjectSha256: facts.sealedObjectSha256, verificationEvidenceSha256: facts.verificationEvidenceSha256, objectKey, files: facts.files });
    this.#artifacts.set(artifactId, sealed); return sealed;
  }
  get(artifactId: string): SealedArtifact | undefined { return this.#artifacts.get(artifactId); }
  async read(input: Readonly<{ artifactId: string; path: string }>): Promise<Readonly<{ bytes: Uint8Array; file: SealedArtifact["files"][number] }> | undefined> {
    const artifact = this.#artifacts.get(input.artifactId); const file = artifact?.files.find((candidate) => candidate.path === input.path);
    if (!artifact || !file) return undefined;
    return Object.freeze({ bytes: await readVerifiedArtifactFile(this.safeObjectPath(artifact.objectKey), file), file });
  }
  private safeObjectPath(value: string): string { const target = resolve(this.#objectRoot, value); if (!target.startsWith(`${this.#objectRoot}${sep}`)) throw new Error("ARTIFACT_OBJECT_PATH_REJECTED"); return target; }
}
