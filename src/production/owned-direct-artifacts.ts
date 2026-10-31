import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import type { ObjectStorePort } from "../continuity/object-store";
import { evaluateArtifactContract } from "../policy/artifact-contract";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { ProductionWorkerPublicationSchema } from "../worker-adapters/publication-metadata";
import { readVerifiedDirectWorkerArchive } from "./direct-artifact-reader";
import { ProductionWorkerArtifactStore } from "./worker-artifact-store";
import { ProductionWorkerRequestStore } from "./worker-request-store";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Profile = z.object({ toolchainSha256: Digest, artifactContract: z.enum(["legacy-aggregate-v1", "nip5d-direct-v1"]).optional() }).strict();
const Command = z.object({ principal: z.object({ pubkey: Digest }).strict(), sessionId: z.string().min(1).max(256), artifactId: z.string().regex(/^artifact:[a-f0-9]{64}$/u) }).strict();
const Row = z.object({ action_id: z.string().min(1), expected_version: z.number().int().nonnegative(), artifact_version: z.number().int().positive(), workspace_id: z.string().min(1) }).strict();

/** Private read authority for signed-principal call sites. SQL grants access to
 * an already finalized artifact; no active lease, checkpoint key, caller build
 * binding or archive field can grant it. Does not authorize publication. */
export class ProductionOwnedDirectArtifacts {
  readonly #pool: PostgresSqlPool;
  readonly #requests: ProductionWorkerRequestStore;
  readonly #artifacts: ProductionWorkerArtifactStore;
  readonly #profiles: readonly z.infer<typeof Profile>[];
  readonly #publication: z.infer<typeof ProductionWorkerPublicationSchema>;
  constructor(input: Readonly<{ pool: PostgresSqlPool; requestJournal: PostgresOperationJournal; objects: ObjectStorePort;
    profiles: readonly z.input<typeof Profile>[]; publication: z.input<typeof ProductionWorkerPublicationSchema> }>) {
    assertPostgresOperationJournal(input.requestJournal);
    this.#pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
    this.#profiles = Object.freeze(z.array(Profile).min(1).max(9).parse(input.profiles).map(profile => Object.freeze(profile)));
    this.#publication = Object.freeze(ProductionWorkerPublicationSchema.parse(input.publication));
    this.#requests = new ProductionWorkerRequestStore(input.requestJournal);
    this.#artifacts = new ProductionWorkerArtifactStore({ journal: input.requestJournal, objects: input.objects,
      toolchainSha256: this.#profiles[0]!.toolchainSha256, retainedToolchainSha256s: this.#profiles.slice(1).map(profile => profile.toolchainSha256) });
  }

  async readVerified(value: unknown) {
    try {
      const command = Command.parse(value), accountId = await accountIdForPrincipal(command.principal);
      const client = await this.#pool.connect();
      let row: z.infer<typeof Row>;
      try {
        const found = await client.query(`SELECT a.id AS action_id,a.expected_session_version AS expected_version,x.version AS artifact_version,a.workspace_lineage AS workspace_id
          FROM production_real.session_artifacts x
          JOIN production_real.metered_actions a ON a.id=x.action_id AND a.account_id=x.account_id AND a.session_id=x.session_id
          JOIN production_real.metered_sessions s ON s.id=x.session_id AND s.account_id=x.account_id
          JOIN production_real.funding_accounts f ON f.account_id=x.account_id
          WHERE x.account_id=$1 AND x.session_id=$2 AND x.id=$3 AND f.accounting_realm='production-real' AND trim(f.nostr_pubkey)=$4
            AND x.verified=true AND a.state='verified' AND a.settled_at IS NOT NULL AND a.terminal_result IS NOT NULL
            AND a.artifact_id=x.id AND a.artifact_version=x.version AND a.session_version=x.version
            AND x.version=a.expected_session_version+1 AND s.version>=x.version AND s.current_verified_artifact_version>=x.version
            AND x.lineage->>'workspaceLineage'=a.workspace_lineage AND x.validation_evidence_reference=a.validation_evidence_reference LIMIT 2`,
        [accountId, command.sessionId, command.artifactId, command.principal.pubkey]);
        if (found.rows.length !== 1) return undefined;
        row = Row.parse(found.rows[0]);
      } finally { client.release(); }
      const request = await this.#requests.readArtifactRequest({ sessionId: command.sessionId, actionId: row.action_id, expectedVersion: row.expected_version });
      if (!request || request.workspaceId !== row.workspace_id || request.workspaceId !== `workspace:${command.sessionId}` || request.capabilityGrant !== "phase-04-coordinator-grant"
        || !request.sourceProposalSha256 || !request.idea) return undefined;
      const stored = await this.#artifacts.read(request);
      if (!stored || stored.accountId !== accountId || stored.ownerId !== command.principal.pubkey || stored.result.artifact.artifactId !== command.artifactId) return undefined;
      const profiles = this.#profiles.filter(profile => profile.toolchainSha256 === stored.toolchainSha256);
      if (!profiles.length || profiles.some(profile => profile.artifactContract !== "nip5d-direct-v1")) return undefined;
      const { sessionId: _session, actionId: _action, expectedVersion: _version, policyVersion: _policy, capabilityGrant: _grant, workspaceId: _workspace, artifactId: _artifact, ...contract } = stored.result.artifact;
      if ((await evaluateArtifactContract(contract)).verdict !== "pass") return undefined;
      const archive = await readVerifiedDirectWorkerArchive(stored.bytes, { checksum: stored.checksum, build: {
        accountId, ownerId: command.principal.pubkey, sessionId: command.sessionId, actionId: row.action_id, expectedVersion: row.expected_version,
        proposalSha256: request.sourceProposalSha256, toolchainSha256: stored.toolchainSha256, publication: this.#publication,
      }, purpose: request.idea });
      if (archive.verificationEvidenceSha256 !== stored.scannerReportSha256 || archive.receipts.conformance.sha256 !== stored.conformanceReportSha256) return undefined;
      return Object.freeze({ accountId, ownerId: command.principal.pubkey, sessionId: command.sessionId, artifactId: command.artifactId, artifactVersion: row.artifact_version,
        policyVersion: request.policyVersion, object: stored.reference, archive });
    } catch { return undefined; }
  }
}
