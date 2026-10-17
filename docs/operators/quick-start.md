# Local installation

## Before you start

Install Git, **Bun 1.3.14**, **Node.js 22 or newer**, and Docker with Compose v2. The verified setup uses Compose 2.39 or newer. Start Docker before the launcher. Allow time and disk space for the first worker image and Chromium download.

The pinned build worker is Linux ARM64; the relay image is AMD64. Docker must support both architectures. Apple Silicon Docker Desktop normally supplies the necessary emulation; Linux CI explicitly installs it. Do not substitute images to work around an architecture error without rerunning conformance.

## Start the stack

```sh
git clone https://github.com/napplet/cvm.git
cd cvm
bun install --frozen-lockfile
bun scripts/dev.ts up
bun scripts/dev.ts status
```

Open the URL printed by `up`; its port is chosen locally. `status` reports readiness, model mode and worker image. The first run installs browser dependencies, builds the pinned worker and creates the local payment services automatically. Subsequent runs preserve state.

Create a small applet using the [first applet guide](../users/quick-start). **Deterministic fixture** means the model response is a sample; the relay, funding, worker, build and verification still run. For prompt-driven generation, [select an account in private admin](./providers).

## Open private admin

From the repository root on the CVM host, run:

```sh
bun scripts/open-dev-admin.ts
```

The opener supplies the local operator credential and the page connects automatically. Opening the admin page without that credential shows the access form below. This is separate from Nostr sign-in in the public workspace. For a named instance, prefix the opener command with the same `NAPPLET_CVM_DEV_INSTANCE` value.

<GuideScreenshot audience="operators" name="access" alt="Private admin access form with an empty Operator access key field and Connect to CVM button" caption="If you see this form, use the admin opener on the CVM host. Keep its credential and launch URL private." />

Once connected, configure [accounts and providers](./providers) or [inspect jobs](./operations#inspect-work). Use **Lock admin** when you finish on a shared browser.

## Stop and return later

```sh
bun scripts/dev.ts down
bun scripts/dev.ts up
```

`down` stops the development services while retaining their persistent state. Wait for active jobs to finish before stopping. Closing the browser does not terminate a CVM job.

To deliberately discard this development instance's state, use `bun scripts/dev.ts reset --confirm`. It removes local accounts, sessions and artifacts; use it only when you want a clean environment. It is not a normal restart step.

## Keep experiments separate

```sh
NAPPLET_CVM_DEV_INSTANCE=experiment bun scripts/dev.ts up
NAPPLET_CVM_DEV_INSTANCE=experiment bun scripts/dev.ts status
NAPPLET_CVM_DEV_INSTANCE=experiment bun scripts/dev.ts down
```

Use the same instance name on every command. Names use lowercase letters, digits and hyphens, up to 48 characters. The default instance stores state under `.local/`; named instances use `.local/napplet-cvm-dev/<name>/` and their own payment stack. The worker image is shared.

## If startup fails

Check Docker is running, inspect the concise launcher error and run `status`. A port conflict, unsupported architecture, offline image download and expired readiness evidence are different failures; do not fix all of them by deleting state. See the [detailed workspace runbook](../runbooks/development-gui) and [payments runbook](../runbooks/development-payments).
