# Operations and backups

## Inspect work

Run `bun scripts/dev.ts status` for local readiness and mode. Open private admin with `bun scripts/open-dev-admin.ts`; its pending, active and finished views show jobs across identities. Open a job for action details. Users can only read their own projects and bounded diagnostics.

### Pending requests

A pending saved idea is not necessarily a queued provider request. Admission accepts immediate capacity or refuses; an unfunded saved draft waits for explicit funding/approval. Read the job state before deciding it is stuck.

<GuideScreenshot audience="operators" name="jobs-pending" alt="Pending jobs view with a saved sample checkpoint awaiting funds" caption="A saved checkpoint can appear under Pending before a model request has started." />

### Active and unconfirmed actions

**Active** also includes `usage_unknown` and `billing_invariant_failed`. Presence in this view alone does not prove a model or worker is still running. Open the job and inspect its recorded state and diagnostic before deciding how to recover it.

<GuideScreenshot audience="operators" name="jobs-active" alt="Active jobs view with one active action and a separate usage_unknown action" caption="Read the State column. A request with an unknown outcome stays in this category until it is reconciled." />

### Finished actions

Use **Finished** to inspect completed or failed actions. A `verified` generation result means the applet passed its checks; it does not by itself confirm user publication. Publication has its own [signing and confirmation flow](../users/publish-and-share).

<GuideScreenshot audience="operators" name="jobs-finished" alt="Finished jobs view showing a sample generation action in verified state" caption="Select the job identifier to inspect the completed action and its evidence." />

### Open a job

Job details include the session and operation identifiers, pinned provider/profile/price card, reserved amount, receipt charge, remaining balances, and available worker/artifact records. Pending-request details contain a smaller set of saved-request fields.

<GuideScreenshot audience="operators" name="job-details" alt="Job details showing a verified action, its session and operation IDs, five-test-sat charge, completed worker and version-two artifact" caption="Compare the reserved amount with the settled charge and released funds. Scroll the dialog when needed; all identifiers here are examples." />

## Recover a failed request

Preserve the session, verified artifact, operation ID and idempotency key. Read status first. If a source proposal and receipt were durably saved, recovery can use them without repeating inference. A missing outcome after dispatch is handled separately from a definite rejection.

Development subscription attempts that have definitely ended without recoverable source/receipt can be closed with a waived local test charge and a new explicit revision. This does not erase upstream subscription usage. Uncertain real API billing remains fenced for reconciliation. Do not delete database rows or replay generation to clear a warning.

See [user troubleshooting](../users/troubleshooting) and the [detailed timeout/recovery notes](../runbooks/development-gui#model-timeouts-and-unconfirmed-outcomes).

## Back up a development instance

The application has durable SQL **and** filesystem state. Copying only the website, `.local/`, or the database is not a complete backup.

1. Stop accepting new work and let active jobs finish. Record the Git revision, worker image digest and launcher status.
2. Use `pg_dump` for the instance's PostgreSQL database with its private connection settings, or a consistent database-volume backup while stopped. Preserve the local mint/wallet/relay volumes as well if you need the full payment/publication test environment.
3. Stop the instance and copy its complete state root and launcher/payment configuration into private backup storage. Preserve permissions, artifact blobs, source/receipt records and checkpoint keys together.
4. Restore into an isolated development instance with the same revision/pins first. Check balances, saved projects, known artifacts and published blob hashes before trying new generation.

There is no one-command backup/restore promise yet. The payment Compose topology and lifecycle are detailed in the [payments runbook](../runbooks/development-payments). Backups contain operator/API/OAuth and payment credentials; they should not become public test artifacts.

## Update the code and authoring skills

Finish active work, preserve state, pull the intended revision and install the frozen root lockfile. Restart with `down` then `up`; the launcher applies the development setup and pinned image checks. Keep the previous revision and matching backup available for rollback. Schema changes need their own migration review.

Skills are installed from the upstream repository using the pinned **skills CLI**, not an `@napplet/skills` package at runtime:

```sh
bun scripts/update-dev-skills.ts <full-upstream-commit-sha>
```

Review and commit the resulting snapshot, then rebuild/restart after work finishes. Generated projects use the checked-in snapshot offline. Follow the [skills runbook](../runbooks/development-gui) and do not change promoted production evidence just to silence a development check.

## Production later

Use [release certification](../runbooks/release-certification) and [deferred production work](../runbooks/production-readiness-deferred) when preparing a production deployment. Development readiness, fixture tests and a public static site do not establish regional failover, real-payment certification or production worker safety.
