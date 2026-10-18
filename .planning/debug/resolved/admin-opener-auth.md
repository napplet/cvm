---
status: resolved
trigger: "bun scripts/open-dev-admin.ts isn't authing admin anymore"
---
# Admin opener authentication

Expected: running the opener restores a usable signed operator session.
Actual: opener launches the admin page but user cannot authenticate.

Evidence: `/health` responds 200, yet `bun scripts/dev.ts status` fails ECONNREFUSED at local Postgres. Docker shows the development relay/mint/database/hub stopped. `open-dev-admin.ts` only reads the launch record and opens a fragment URL; it does not ensure dependencies. `dev.ts up` exits at failed readiness for an existing HTTP-alive process instead of restoring dependencies. Also inspect fragment handling for same-document browser/tab reuse and explicit `NAPPLET_CVM_DEV_INSTANCE=default` path inconsistency.

Root cause confirmed: a live HTTP process can outlast its stopped relay/database. Launcher `up` aborted at readiness instead of recovering. Restarting only the stopped relay/database also leaves the running NWC hub on a dead relay connection. A second browser path was reproduced: navigating a locked existing document to a key fragment does not re-run its module, so its initial-only credential handler ignored the key. Explicit `NAPPLET_CVM_DEV_INSTANCE=default` selected an incorrect named-instance path in the opener.

Fix: opener runs readiness-aware `dev.ts up`, anchors paths to its repository, treats explicit default consistently, opens a unique nonsecret launch URL and retains the key in a removed fragment. Admin handles fresh fragment handoffs into existing documents. Launcher recovers unavailable dependencies by recreating the stack together while retaining volumes/configuration; invariant/configuration failures still fail closed.

Verification: `tests/dev-ui/admin-opener.e2e.ts` passed with the actual opener and isolated real CVM/relay/SQL. It proves initial signed auto-login, reused locked-document login, HTTP-alive stopped Postgres/relay recovery, preserved operator key and secret-free stdout/visible URL. A polling assertion was corrected to wait for authenticated content across navigation instead of a detached login form. Default-instance real OS opener succeeded; live readiness passed with ChatGPT OAuth/model/rates retained. Docs build/link checks passed. Typecheck remains at the existing 411-diagnostic baseline with no added errors. No live generation or pricing change.
