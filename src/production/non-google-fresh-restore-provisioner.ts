import { createHash } from "node:crypto";
import type { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import type { NonGoogleCoreBinding, NonGoogleCoreHeld } from "./non-google-telemetry-certification";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Records the original fresh-instance intent before a future sealed native
 * provisioner may create anything. It has no dependency on Cloud SQL, GCS or
 * their historical receipts. A held result is a real refusal, never a fake
 * restore or a replacement operation.
 */
export class NonGoogleFreshRestoreProvisioner {
  constructor(private readonly input: Readonly<{ binding: NonGoogleCoreBinding; journal?: PostgresOperationJournal }>) { Object.freeze(this); }
  async prepare(input: Readonly<{ operationId: string; sourceInstanceId: string; backupSha256: string }>): Promise<Readonly<{ status: "prepared" } | NonGoogleCoreHeld>> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u.test(input.sourceInstanceId) || !/^[a-f0-9]{64}$/u.test(input.backupSha256)) throw new Error("NON_GOOGLE_FRESH_RESTORE_INPUT_DENIED");
    if (!this.input.journal) return Object.freeze({ status: "held" as const, reason: "SUCCESSOR_AUTHORITY_HELD" as const });
    const identity = sha({ version: 1, binding: this.input.binding, ...input });
    await this.input.journal.claim(`non-google-restore:${input.operationId}`, identity, { version: 1, binding: this.input.binding, ...input, state: "prepared" });
    return Object.freeze({ status: "prepared" as const });
  }
}
