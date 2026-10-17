import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import type { LocalArtifactRepository } from "./local-artifact-repository";

export const RestoreRevisionArgumentsSchema = z.object({
  action: z.literal("restore"), id: z.string().min(1).max(240),
  artifactId: z.string().regex(/^artifact:sha256:[a-f0-9]{64}$/),
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).max(240),
}).strict();

/** Select an existing verified source, without changing artifacts or billing. */
export class ProjectRevisions {
  constructor(private readonly pool: PostgresSqlPool, private readonly artifacts: LocalArtifactRepository) {}

  async restore(input: unknown, verifiedPubkey: string) {
    const command = RestoreRevisionArgumentsSchema.parse(input);
    const accountId = await accountIdForPrincipal({ pubkey: verifiedPubkey });
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      // Generation admission locks and writes this same row. Whichever wins
      // advances the version or sets active, fencing the other command.
      const session = (await client.query(`SELECT s.version,s.state,s.current_verified_artifact_version
        FROM metered_sessions s JOIN development_projects p ON p.id=s.id
        WHERE s.id=$1 AND s.account_id=$2 AND p.owner_pubkey=$3 FOR UPDATE OF s`,
      [command.id, accountId, verifiedPubkey])).rows[0];
      if (!session) return { status: "not_found_or_denied" };
      const prior = (await client.query(`SELECT session_id,artifact_id,expected_version,result_version,artifact_version
        FROM development_revision_restores WHERE account_id=$1 AND idempotency_key=$2`, [accountId, command.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.session_id !== command.id || prior.artifact_id !== command.artifactId || Number(prior.expected_version) !== command.expectedVersion)
          return { status: "conflict", code: "IDEMPOTENCY_KEY_CONFLICT" };
        return { status: "restored", sessionVersion: Number(prior.result_version), artifactVersion: Number(prior.artifact_version), artifactId: prior.artifact_id, charge: "0" };
      }
      if (Number(session.version) !== command.expectedVersion) return { status: "conflict", code: "STALE_SESSION_VERSION" };
      if (!["verified", "failed"].includes(String(session.state)) || (await client.query(
        "SELECT id FROM metered_actions WHERE session_id=$1 AND (terminal_result IS NULL OR state IN ('usage_unknown','billing_invariant_failed')) LIMIT 1", [command.id])).rows.length)
        return { status: "busy", code: "SESSION_NOT_REVISION_READY" };
      const verified = (await client.query(`SELECT artifact_version FROM metered_actions
        WHERE account_id=$1 AND session_id=$2 AND artifact_id=$3 AND state='verified' AND terminal_result IS NOT NULL`,
      [accountId, command.id, command.artifactId])).rows[0];
      if (!verified) return { status: "not_found_or_denied" };
      const artifact = await this.artifacts.get(command.artifactId);
      if (!artifact || artifact.accountId !== accountId || artifact.sessionId !== command.id || artifact.version !== Number(verified.artifact_version))
        return { status: "unavailable", code: "REVISION_UNAVAILABLE" };
      for (const file of artifact.files) await this.artifacts.read({ artifactId: artifact.artifactId, path: file.path });
      const source = await client.query("SELECT proposal_sha256 FROM source_proposals WHERE proposal_sha256=$1 AND account_id=$2 AND session_id=$3 AND action_id=$4", [artifact.proposalSha256, accountId, command.id, artifact.actionId]);
      if (!source.rows.length) return { status: "unavailable", code: "REVISION_SOURCE_UNAVAILABLE" };
      const version = command.expectedVersion + 1;
      await client.query("UPDATE metered_sessions SET version=$3,current_verified_artifact_version=$4,state='verified' WHERE account_id=$1 AND id=$2", [accountId, command.id, version, artifact.version]);
      await client.query(`INSERT INTO development_revision_restores
        (account_id,session_id,idempotency_key,expected_version,result_version,from_version,artifact_version,artifact_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [accountId, command.id, command.idempotencyKey, command.expectedVersion, version, session.current_verified_artifact_version, artifact.version, artifact.artifactId]);
      await client.query("COMMIT"); committed = true;
      return { status: "restored", sessionVersion: version, artifactVersion: artifact.version, artifactId: artifact.artifactId, charge: "0" };
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }
}
