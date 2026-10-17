# Operations and backups

## Inspect work

Run `bun scripts/dev.ts status` for local readiness and mode. Open private admin with `bun scripts/open-dev-admin.ts`. **Jobs** is the first view, with **All** selected. Provider accounts and rates are under **Provider & rates**. Users can only read their own projects; this operator view spans identities.

<GuideScreenshot audience="operators" name="jobs-all" alt="Admin All view with readable applet names, status badges, charges, held funds and filter counts" caption="Search by applet, request, model or identifier. Open an applet name for the job’s details." />

### Find the right jobs

| View | What it contains |
| --- | --- |
| All | Every recorded action and saved request; admitted requests are counted once. |
| Pending | Prepared work and saved requests awaiting funds. |
| Active | Actions recorded as running. A stale action still needs investigation; this is not a worker heartbeat. |
| Needs review | Missing provider receipts, billing mismatches, or incomplete admission records. |
| Finished | Ready, stopped, completed and expired work. |

Counts follow your search. Results refresh every five seconds without disabling job links, with 50 jobs per page. On phones, results become cards rather than a horizontally scrolling table.

<GuideScreenshot audience="operators" name="jobs-pending" alt="Pending jobs view with a saved applet awaiting funds and no charge" caption="A saved request has not reserved funds or started inference yet." />

<GuideScreenshot audience="operators" name="jobs-active" alt="Active job showing a focus timer running with a 395-test-sat reservation" caption="Reserved is an authorization, not a confirmed charge." />

<GuideScreenshot audience="operators" name="jobs-finished" alt="Finished reading-counter job with five test sats settled" caption="Ready means generation passed its checks. User publication has a separate signing and confirmation flow." />

### Understand the money

**Confirmed charges** sums settled actions. **Reserved for review** shows action authorizations still held against jobs needing attention. These are separate amounts, and development test sats are labelled separately from provider-priced sats. A zero or waived local charge is never evidence of zero upstream usage.

Each job opens with its request, confirmed charge, still-reserved amount and approved maximum. The usage section shows recorded token counts, model, timing and worker results. **Identifiers & ledger** contains operation IDs, original price version and individual ledger entries.

<GuideScreenshot audience="operators" name="job-details" alt="Structured job details with confirmed charge, reservation, maximum, token usage and execution facts" caption="Receipt charges use the job’s original immutable price card, even after the operator changes rates." />

### Recover missing usage {#recover-a-failed-request}

A provider can accept a request and then lose its connection before delivering a final usage receipt. Local storage can also fail after a response arrives. The service cannot truthfully infer an exact token count from missing evidence. Such a request is **Receipt missing** under **Needs review**, not a free action or proof of running generation.

<GuideScreenshot audience="operators" name="jobs-review" alt="Needs review filter showing an unsettled job and its protected test-sat reservation" caption="Missing receipts remain visible separately from active generation." />

Open the job and select **Check receipt**. It checks the CVM’s saved, correlated evidence without making a model request. A valid receipt settles exactly once at the original rates. If no receipt exists, funds remain reserved; conflicts also remain unresolved. This button cannot retrieve usage that the provider never delivered. It never guesses zero usage or charges the approved maximum as if it were actual usage.

Valid receipts are journaled before parsing or saving generated source, so invalid output and source-storage failures retain their billable usage. Do not delete rows or repeat inference to clear a warning.

Development subscription attempts that have ended without recoverable source/receipt can still be closed through the existing session-recovery policy, with the operator absorbing the local test charge. Admin labels these **Operator absorbed**; upstream subscription usage remains unconfirmed. Known journaled usage is never waived by this policy. Real API billing remains fenced until reconciliation.

See [user troubleshooting](../users/troubleshooting) and [timeout/recovery notes](../runbooks/development-gui#model-timeouts-and-unconfirmed-outcomes).

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
