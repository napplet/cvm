/** A money transaction attempted COMMIT but its outcome was not acknowledged.
 * Callers may observe the original result; absence is not rollback authority. */
export class FundingCommitOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "FUNDING_COMMIT_OUTCOME_UNKNOWN", { cause });
    this.name = "FundingCommitOutcomeUnknownError";
  }
}
