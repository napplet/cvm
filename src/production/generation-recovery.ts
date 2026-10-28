import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import { RetainedGenerationCommandSchema, type GenerationCommandProtector } from "../model/retained-generation-command";
import type { MeteredGenerationService } from "../phase-04/metered-generation-service";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";

/** Bounded discovery of already accepted, funded originals. No admission queue,
 * command synthesis, fixture pricing or replacement provider operation. */
export class ProductionGenerationRecovery {
  readonly #pool: PostgresSqlPool;
  #active: Promise<Readonly<{ attempted: number; erased: number }>> | undefined;
  #stopped = false;
  constructor(private readonly input: Readonly<{ pool: PostgresSqlPool; commands: GenerationCommandProtector; acceptedToolchains: readonly string[]; generation: Pick<MeteredGenerationService,"recoverRecordedAction"> }>) {
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
  }
  scan(): Promise<Readonly<{ attempted: number; erased: number }>> {
    if (this.#stopped) return Promise.resolve({ attempted: 0, erased: 0 });
    if (this.#active) return this.#active;
    const run = this.#scan().finally(() => { this.#active = undefined; });
    this.#active = run; return run;
  }
  async assertReady(): Promise<void> {
    const client = await this.#pool.connect();
    try { await client.query("SELECT operation_id,binding_json,envelope_json,command_sha256,retention_until,state,next_attempt_at,claim_token,claim_until FROM production_real.generation_recovery_commands LIMIT 0"); }
    finally { client.release(); }
  }
  async close(): Promise<void> { this.#stopped = true; await this.#active; }
  async #scan() {
    const client = await this.#pool.connect();
    let erased = 0, attempted = 0;
    try {
      // Erase only bounded due records. The trigger independently requires a
      // terminal original or expiry; identity/hash audit metadata survives.
      const disposed = await client.query("UPDATE production_real.generation_recovery_commands c SET state='erased',envelope_json=NULL,erased_at=clock_timestamp(),claim_token=NULL,claim_until=NULL WHERE c.operation_id IN (SELECT d.operation_id FROM production_real.generation_recovery_commands d JOIN production_real.metered_actions a ON a.id=d.action_id WHERE d.state='retained' AND (d.retention_until<=clock_timestamp() OR a.terminal_result IS NOT NULL) ORDER BY d.retention_until,d.operation_id LIMIT 100) AND c.state='retained' RETURNING operation_id");
      erased = disposed.rows.length;
      const candidates = await client.query("SELECT c.operation_id FROM production_real.generation_recovery_commands c JOIN production_real.metered_actions a ON a.id=c.action_id WHERE c.state='retained' AND c.retention_until>clock_timestamp() AND c.next_attempt_at<=clock_timestamp() AND (c.claim_until IS NULL OR c.claim_until<=clock_timestamp()) AND a.terminal_result IS NULL ORDER BY c.next_attempt_at,c.operation_id LIMIT 100");
      for (const candidate of candidates.rows) {
        if (this.#stopped) break;
        const operationId = String(candidate.operation_id), token = crypto.randomUUID();
        const claimed = await client.query("UPDATE production_real.generation_recovery_commands SET claim_token=$2,claim_until=clock_timestamp()+interval '60 seconds',next_attempt_at=clock_timestamp()+interval '30 seconds' WHERE operation_id=$1 AND state='retained' AND retention_until>clock_timestamp() AND next_attempt_at<=clock_timestamp() AND (claim_until IS NULL OR claim_until<=clock_timestamp()) RETURNING binding_json,envelope_json", [operationId,token]);
        if (!claimed.rows[0]) continue;
        attempted++;
        // A lease bounds duplicate observation after process loss. Original
        // provider/worker durable effect fences remain authority if a lease is
        // lost while an older process is still returning from a provider call.
        let renewal: Promise<void> | undefined;
        const timer = setInterval(() => {
          if (renewal) return;
          renewal = client.query("UPDATE production_real.generation_recovery_commands SET claim_until=clock_timestamp()+interval '60 seconds' WHERE operation_id=$1 AND claim_token=$2 AND state='retained'", [operationId,token]).then(() => undefined, () => undefined).finally(() => { renewal = undefined; });
        },20_000);
        timer.unref?.();
        try {
          const row = claimed.rows[0];
          const record = RetainedGenerationCommandSchema.parse({ binding: row.binding_json, envelope: row.envelope_json });
          if (record.binding.operationId !== operationId || !this.input.acceptedToolchains.includes(record.binding.toolchainId)) throw new Error("GENERATION_RECOVERY_OPERATION_MISMATCH");
          const command = await this.input.commands.open(record);
          await this.input.generation.recoverRecordedAction({ command, operationId });
        } catch {
          // Unknown/malformed/missing retained evidence does not release a
          // reservation, replace prices, fabricate a receipt or retry POST.
        } finally {
          clearInterval(timer);
          await renewal;
          await client.query("UPDATE production_real.generation_recovery_commands SET claim_token=NULL,claim_until=NULL,next_attempt_at=clock_timestamp()+interval '30 seconds' WHERE operation_id=$1 AND claim_token=$2", [operationId,token]);
        }
      }
      return Object.freeze({ attempted, erased });
    } finally { client.release(); }
  }
}
