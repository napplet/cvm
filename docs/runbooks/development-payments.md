# Local Cashu and NWC payments

Production certification is deferred and does not block this development setup. The [production follow-up](production-readiness-deferred.md) records the remaining work and when to resume it.

Prerequisites: Bun, installed repository dependencies (`bun install --frozen-lockfile`), and Docker with Compose v2 running. No account, real funds, faucet, Lightning channels, or manual wallet setup is required.

```sh
bun scripts/dev-payments.ts
bun scripts/dev-payments.ts test
```

The first command starts three version- and digest-pinned upstream services, waits for readiness, creates and unlocks the wallet, creates an NWC app connection, funds it with 10,000 test sats when its balance is below 1,000 sats, and issues a fresh 1,024-sat Cashu token. Initial startup downloads the images. Later runs reuse the wallet and mint volumes.

| Service | Local address | Implementation |
| --- | --- | --- |
| Cashu mint | `http://127.0.0.1:3338` | Nutshell 0.19.1, FakeWallet backend |
| Nostr relay | `ws://127.0.0.1:7777` | nostr-rs-relay 0.9.0 |
| NWC wallet UI/API | `http://127.0.0.1:8081` | Alby Hub 1.24.1, Cashu backend |

Alby Hub uses the same mint as its wallet backend. Its NWC protocol requests travel over the local relay; incoming invoices automatically settle through FakeWallet. Nutshell 0.19.1 is intentional: the tested Hub wallet uses v1 keyset IDs; Nutshell 0.21.0's default v2 IDs prevented wallet startup in this combination. The relay's pinned image is amd64 and runs under Docker Desktop emulation on Apple Silicon.

Setup saves credentials in ignored, private files:

- `.local/napplet-cvm-dev-payments/payments.json`: `mintUrl`, `relayUrl`, `hubUrl`, `nwcUri`, `cashuToken`, and `developmentOnly: true`.
- `.local/napplet-cvm-dev-payments/password.json`: generated Hub UI password, represented as a JSON string.
- `.local/napplet-cvm-dev-payments/connection.json`: persistent NWC connection.

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

```sh
bun scripts/dev-payments.ts down   # stop services; retain wallet and mint
bun scripts/dev-payments.ts       # restart and unlock automatically
bun scripts/dev-payments.ts reset # delete ONLY this development stack's volumes and credentials
```

If a fixed port is busy, stop its conflicting service. For failed startup, inspect `docker compose -p napplet-cvm-dev-payments -f infra/dev-payments/compose.yaml ps -a` and service logs locally; logs may contain test payment data. Reset recreates the entire development wallet if credentials and volumes become inconsistent.

## End-to-end tests and CI

`bun scripts/dev-payments.ts test` automatically creates a separate stack with a unique project name, fresh credentials, and Docker-assigned loopback ports. It checks Cashu issuance, swap fees, spent-proof detection and replay rejection; encrypted and signed NWC info, balance, invoice creation, settlement, outgoing payment and replay accounting; and persistence after stop/restart. A `finally` block removes that test stack's containers, volumes and local credentials, including on assertion failure. It leaves the development stack intact. Interrupted/killed processes may need manual cleanup of their uniquely named `napplet-cvm-payments-test-*` stack.

The ordinary `bun test` skips this Docker suite. The dedicated GitHub Actions workflow runs it with Docker, Bun and the frozen lockfile. No payment credentials are needed in CI.

This is payment-infrastructure e2e coverage using real Cashu/NWC protocols and simulated Lightning settlement. It does not certify real Lightning routing, CEP-8 ledger integration, production funding, or a full generation session. The production HTTPS mint policy and release approval gates remain in force; local files are not fed into release certification or the operator Keychain.

Upstream references: [Nutshell FakeWallet](https://github.com/cashubtc/nutshell/blob/0.19.1/cashu/lightning/fake.py), [Alby Hub Cashu backend](https://github.com/getAlby/hub/tree/v1.24.1/lnclient/cashu), [nostr-rs-relay](https://github.com/scsibug/nostr-rs-relay).
