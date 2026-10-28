import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ProductionConfig } from "./config";

const BINDINGS = Object.freeze(["cloudSql.roleCredentialReference", "cloudSql.restoreRecoveredRoleCredentialReference", "cloudSql.restoreMigrationRoleCredentialReference", "contextvm.serviceKeyReference", "certification.authorizationRequestReference", "certification.authorizationReceiptReference", "certification.clientKeyReference", "certification.sessionMaterialReference", "funding.nwcConnectionReference", "funding.cashuConsentReference", "funding.protectedMaterialReference", "funding.admissionReceiptReference", "funding.statusCursorReference", "vertex.credentialReference", "worker.modalAccessReference", "worker.flyAccessReference", "publication.cliSourceReference", "publication.signerBrokerReference", "publication.signerSessionKeyReference", "publication.attestationKeyReference", "gcs.migrationBackupKeyReference", "checkpoint.kekReference"] as const);
type BindingName = typeof BINDINGS[number];
const referencePattern = /^[a-z][a-z0-9:._/-]{2,255}$/iu;
function filename(reference: string): string { if (!referencePattern.test(reference)) throw new Error("PRODUCTION_SECRET_REFERENCE_INVALID"); return reference.replaceAll(/[^a-z0-9._-]/giu, "_"); }

/** Closed Cloud Run Secret Manager mount reader. It cannot resolve arbitrary
 * names, environment variables, user keys, or paths; values never enter logs. */
export class MountedProductionSecretMaterial {
  readonly #root: string;
  readonly #references: Readonly<Record<BindingName, string>>;
  constructor(config: ProductionConfig, options: Readonly<{ root?: string }> = {}) {
    this.#root = resolve(options.root ?? "/var/run/secrets/napplet-cvm");
    this.#references = Object.freeze({ "cloudSql.roleCredentialReference": config.cloudSql.roleCredentialReference, "cloudSql.restoreRecoveredRoleCredentialReference": config.cloudSql.restoreRecoveredRoleCredentialReference, "cloudSql.restoreMigrationRoleCredentialReference": config.cloudSql.restoreMigrationRoleCredentialReference, "contextvm.serviceKeyReference": config.contextvm.serviceKeyReference, "certification.authorizationRequestReference": config.certification.authorizationRequestReference, "certification.authorizationReceiptReference": config.certification.authorizationReceiptReference, "certification.clientKeyReference": config.certification.clientKeyReference, "certification.sessionMaterialReference": config.certification.sessionMaterialReference, "funding.nwcConnectionReference": config.funding.nwcConnectionReference, "funding.cashuConsentReference": config.funding.cashuConsentReference, "funding.protectedMaterialReference": config.funding.protectedMaterialReference, "funding.admissionReceiptReference": config.funding.admissionReceiptReference, "funding.statusCursorReference": config.funding.statusCursorReference, "vertex.credentialReference": config.vertex.credentialReference, "worker.modalAccessReference": config.worker.modalAccessReference, "worker.flyAccessReference": config.worker.flyAccessReference, "publication.cliSourceReference": config.publication.cliSourceReference, "publication.signerBrokerReference": config.publication.signerBrokerReference, "publication.signerSessionKeyReference": config.publication.signerSessionKeyReference, "publication.attestationKeyReference": config.publication.attestationKeyReference, "gcs.migrationBackupKeyReference": config.gcs.migrationBackupKeyReference, "checkpoint.kekReference": config.checkpoint.kekReference });
  }
  reference(name: BindingName): string { return this.#references[name]; }
  /** Fixed, allowlisted Secret Manager mount path; callers cannot select an arbitrary file. */
  path(name: BindingName): string {
    const path = resolve(this.#root, filename(this.#references[name]));
    if (!path.startsWith(`${this.#root}${sep}`)) throw new Error("PRODUCTION_SECRET_PATH_DENIED");
    return path;
  }
  async text(name: BindingName, limit = 65_536): Promise<string> {
    const path = this.path(name);
    const bytes = new Uint8Array(await readFile(path));
    try { if (bytes.byteLength === 0 || bytes.byteLength > limit || bytes.includes(0)) throw new Error("PRODUCTION_SECRET_MATERIAL_INVALID"); return new TextDecoder().decode(bytes).trim(); }
    finally { bytes.fill(0); }
  }
  async bytes32(name: "funding.protectedMaterialReference" | "funding.admissionReceiptReference" | "funding.statusCursorReference" | "gcs.migrationBackupKeyReference"): Promise<Uint8Array> {
    const value = await this.text(name, 128); const decoded = new Uint8Array(Buffer.from(value, "base64"));
    if (decoded.byteLength !== 32 || Buffer.from(decoded).toString("base64") !== value) { decoded.fill(0); throw new Error("PRODUCTION_SECRET_MATERIAL_INVALID"); }
    return decoded;
  }
}
