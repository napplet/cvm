import { createHash } from "node:crypto";
import { canonicalJson } from "../../promotion/schema";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "./postgres-operation-journal";
import { OpenAiResponsesJournalEntrySchema, type OpenAiResponsesOperationJournal } from "./openai-responses-client";

function identity(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

/** A narrow durable adapter for the v2 candidate. It deliberately does not
 * change the shared provider-journal module or construct a runtime client.
 * The original entry commits before `create` can receive any authorization. */
export function createPostgresOpenAiResponsesOperationJournal(journal: PostgresOperationJournal): OpenAiResponsesOperationJournal {
  assertPostgresOperationJournal(journal);
  journal.assertOpenAiResponsesPurpose();
  return Object.freeze({
    async claim(entry) {
      const parsed = OpenAiResponsesJournalEntrySchema.parse(entry);
      const claimed = await journal.claim(parsed.operationId, identity(parsed), parsed);
      return Object.freeze({ claimed: claimed.claimed, entry: claimed.record.value });
    },
    async read(operationId) {
      return (await journal.read(operationId))?.value;
    },
    async write(entry) {
      const parsed = OpenAiResponsesJournalEntrySchema.parse(entry);
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = await journal.read<unknown>(parsed.operationId);
        if (!current) throw new Error("OPENAI_RESPONSES_JOURNAL_MISSING");
        const previous = OpenAiResponsesJournalEntrySchema.safeParse(current.value);
        if (!previous.success || previous.data.requestSha256 !== parsed.requestSha256 || previous.data.nonce !== parsed.nonce || previous.data.clientRequestId !== parsed.clientRequestId || previous.data.candidateSha256 !== parsed.candidateSha256 || previous.data.credentialReference !== parsed.credentialReference || previous.data.model !== parsed.model || canonicalJson(previous.data.rate) !== canonicalJson(parsed.rate) || previous.data.maximumChargeMicros !== parsed.maximumChargeMicros) throw new Error("OPENAI_RESPONSES_JOURNAL_IDENTITY_CONFLICT");
        if (previous.data.completedReceipt !== undefined && canonicalJson(previous.data.completedReceipt) !== canonicalJson(parsed.completedReceipt)) throw new Error("OPENAI_RESPONSES_JOURNAL_TERMINAL_CONFLICT");
        if (previous.data.responseId !== undefined && previous.data.responseId !== parsed.responseId) throw new Error("OPENAI_RESPONSES_JOURNAL_RESPONSE_ID_CONFLICT");
        const saved = await journal.compareAndSet(parsed.operationId, current.identitySha256, current.revision, parsed);
        if (saved) return;
      }
      throw new Error("OPENAI_RESPONSES_JOURNAL_CAS_EXHAUSTED");
    },
  });
}
