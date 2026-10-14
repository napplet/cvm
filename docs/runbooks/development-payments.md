# Local Cashu and NWC payments

Production certification is deferred and does not block this development setup. The [production follow-up](production-readiness-deferred.md) records the remaining work and when to resume it.

Prerequisites: Bun, installed repository dependencies (`bun install --frozen-lockfile`), and Docker with Compose v2 running. No account, real funds, faucet, Lightning channels, or manual wallet setup is required.

```sh
bun scripts/dev-payments.ts
bun scripts/dev-payments.ts test
```

The first command starts five version- and digest-pinned upstream services, waits for readiness, applies the repository's four PostgreSQL migrations, creates and unlocks the wallet, creates an NWC app connection, funds it with 10,000 test sats when its balance is below 1,000 sats, and issues a fresh 1,024-sat Cashu token. Initial startup downloads the images. Later runs reuse the wallet, mint and database volumes. Migration checksums reject changed SQL on an existing volume; use `reset` to recreate disposable development data when the schema changes.

| Service | Local address | Implementation |
| --- | --- | --- |
| Cashu mint | `http://127.0.0.1:3338` | Nutshell 0.19.1, FakeWallet backend |
| Second Cashu mint | `http://127.0.0.1:3339` | Independent Nutshell keyset and volume |
| Nostr relay | `ws://127.0.0.1:7777` | nostr-rs-relay 0.9.0 |
| NWC wallet UI/API | `http://127.0.0.1:8081` | Alby Hub 1.24.1, Cashu backend |
| PostgreSQL ledger | `127.0.0.1:55432` | PostgreSQL 17.11, database/user `napplet_dev` |

Alby Hub uses the same mint as its wallet backend. Its NWC protocol requests travel over the local relay; incoming invoices automatically settle through FakeWallet. Nutshell 0.19.1 is intentional: the tested Hub wallet uses v1 keyset IDs; Nutshell 0.21.0's default v2 IDs prevented wallet startup in this combination. The relay's pinned image is amd64 and runs under Docker Desktop emulation on Apple Silicon.

Setup saves credentials in ignored, private files:

- `.local/napplet-cvm-dev-payments/payments.json`: `mintUrl`, `secondaryMintUrl`, `relayUrl`, `hubUrl`, `nwcUri`, `cashuToken`, `databaseUrl`, `fundingKey`, and `developmentOnly: true`.
- `.local/napplet-cvm-dev-payments/password.json`: generated Hub UI password, represented as a JSON string.
- `.local/napplet-cvm-dev-payments/connection.json`: persistent NWC connection.
- `.local/napplet-cvm-dev-payments/funding-key.json`: persistent AES-GCM key for protected application payment material.

Read `payments.json` in a development client or test harness. For example:

```ts
import { Wallet } from "@cashu/cashu-ts";
import { nwcRequest } from "../../scripts/dev-payments"; // adjust relative path

const payments = await Bun.file(".local/napplet-cvm-dev-payments/payments.json").json();
const balance = await nwcRequest(payments.nwcUri, "get_balance");
const wallet = new Wallet(payments.mintUrl);
await wallet.loadMint();
const proofs = await wallet.receive(payments.cashuToken);
```

Cashu tokens are single-use; rerun setup for a fresh token. Swaps deduct the mint's advertised fees. NWC amounts are millisatoshis. Use `lookup_invoice` after `make_invoice` to trigger Hub's Cashu settlement check. These files contain development bearer credentials; setup prints only their location. All published ports bind to loopback. Hub telemetry and automatic Alby account linking are disabled.

## Application funding

`scripts/dev-funding.ts` composes the existing funding service, both rail coordinators, PostgreSQL repositories and encrypted rail vault. It uses the NWC receiver's signed observations and real Cashu swaps. The application account starts at zero; the wallet's bootstrap funds do not directly seed the ledger.

```ts
import { createDevelopmentFunding } from "../../scripts/dev-funding";

const payments = await Bun.file(".local/napplet-cvm-dev-payments/payments.json").json();
const app = await createDevelopmentFunding(payments);
const principal = { pubkey: "ab".repeat(32) }; // disposable development account
try {
  const topUpId = crypto.randomUUID();
  await app.cashu.submit({
    principal, topUpId, idempotencyKey: topUpId, amount: "1024", unit: "sat",
    pmi: "bitcoin-cashu-v4-direct", token: app.applicationToken(payments.cashuToken),
  });
  const balance = await app.funding.status(principal);
} finally {
  await app.close();
}
```

Run this with a fresh token that the earlier wallet example has not consumed. For Lightning use `app.lightning.begin({ principal, idempotencyKey, amount: "37", unit: "sat", policyVersion: "development-local-v1", protocolVersion: "funding-contract-v1" })`, then poll `app.lightning.observeSettlement({ principal, topUpId })` until credited. The same command key reuses the original invoice. A create request lost before its payment hash is saved stays `reconciliation_pending`; NIP-47 has no create-by-idempotency-key lookup, and this adapter never creates a replacement automatically.

The two independent mints satisfy the application's existing multi-mint policy. The development adapter routes reserved `https://mint.dev.invalid` and `https://mint-secondary.dev.invalid` aliases directly to the configured loopback HTTP endpoints through cashu-ts's custom request seam. `applicationToken` changes only the mint URL in the token envelope; proofs remain upstream-issued. These names require no DNS or TLS setup. External endpoints and redirects are rejected. Production's HTTPS policy is unchanged. The ledger credits the submitted face amount under its current contract; the service absorbs mint swap fees. This harness does not establish durable treasury custody or recovery of ambiguous Cashu swaps.

```sh
bun scripts/dev-payments.ts down   # stop services; retain wallet, mints and ledger
bun scripts/dev-payments.ts       # restart and unlock automatically
bun scripts/dev-payments.ts reset # delete ONLY this development stack's volumes and credentials
```

If a fixed port is busy, stop its conflicting service. For failed startup, inspect `docker compose -p napplet-cvm-dev-payments -f infra/dev-payments/compose.yaml ps -a` and service logs locally; logs may contain test payment data. Reset recreates the entire development wallet if credentials and volumes become inconsistent.

## End-to-end tests and CI

`bun scripts/dev-payments.ts test` automatically creates separate stacks with unique project names, fresh credentials, and Docker-assigned loopback ports. The infrastructure test checks Cashu issuance, swap fees, spent-proof detection and replay rejection; encrypted and signed NWC info, balance, invoice creation, settlement, outgoing payment and replay accounting; and wallet persistence. The application test credits both Cashu mints and NWC through the real coordinators into PostgreSQL, checks ownership and exact-command/token replay, balanced ledger entries, credit outbox/billing projections, and encrypted invoice storage/expiry. It closes all application connections and restarts the containers before replaying credited commands and settling a pending invoice. A `finally` block removes each test stack's containers, volumes and local credentials, including on assertion failure. It leaves the development stack intact. Interrupted/killed processes may need manual cleanup of their uniquely named `napplet-cvm-payments-test-*` stack.

The ordinary `bun test` skips this Docker suite. The dedicated GitHub Actions workflow runs it with Docker, Bun and the frozen lockfile. No payment credentials are needed in CI.

This covers payment infrastructure and the application funding/ledger boundary using real Cashu/NWC protocols and simulated Lightning settlement. ContextVM/CEP-8 wire negotiation, real Lightning routing, production funding, durable treasury recovery, and a full generation session remain outside these tests. Local files are not fed into release certification or the operator Keychain.

Upstream references: [Nutshell FakeWallet](https://github.com/cashubtc/nutshell/blob/0.19.1/cashu/lightning/fake.py), [Alby Hub Cashu backend](https://github.com/getAlby/hub/tree/v1.24.1/lnclient/cashu), [nostr-rs-relay](https://github.com/scsibug/nostr-rs-relay), [official PostgreSQL image](https://hub.docker.com/_/postgres).
