# Development ContextVM wire probe

Date: 2026-10-15. Scope: implementation preflight for the development GUI.

## Verified locally

- Bun's browser bundler successfully bundled the installed `@contextvm/sdk@0.13.10` Nostr client transport (1,197,159 bytes, no build errors). This proves bundling only; browser execution still needs the browser E2E test.
- An ephemeral SDK client and SDK server exchanged a signed, encrypted `tools/call` request and response through the existing local relay at `ws://127.0.0.1:7777`. `ContextVmSdkBridge` preserved the verified client public key and the actual signed request event ID.
- The real `ContextVmFundingAdapter` and `createDevelopmentFunding` composition accepted a newly minted 64-sat Cashu token over that encrypted wire. Replaying the same application command/token returned the credited result without another credit.
- A 37-sat NWC invoice was created through the same wire. The probe called the existing `LightningTopUpCoordinator.observeSettlement` on the server until the local wallet confirmed it.
- `account_status` over ContextVM reported an initial available balance of `0` and a final balance of `101`. No service credential or user signing key was sent in application responses or probe output.
- All five default development payment containers were running during this probe: PostgreSQL, primary/secondary mint, Hub, and relay. The earlier research observation that none were running does not describe this current state.

The temporary probe is `/tmp/napplet-cvm-wire-probe.ts`. It reads private local configuration at runtime and creates disposable signing keys in memory. Convert its useful assertions into repository-owned automated tests; the temporary file is not a deliverable or a launch dependency.

## Implementation decisions

Use the official browser SDK client and `NostrServerTransport` with `ContextVmSdkBridge`. No HTTP generation bridge or transport test double is needed.

For top-ups, a narrow client subclass can override the SDK's protected `sendMcpMessage` to attach payment tags to that individual request before SDK signing/encryption. Correlate Cashu material by request ID and remove it after completion. Never keep shared mutable "next request" tags, put tokens in logs, or send tokens outside the encrypted SDK envelope. The existing adapter requires a `pmi` tag on each top-up, a matching `payment_interaction`, and (for Cashu) `direct_payment` with the token.

The running development composition needs bounded, restart-aware NWC settlement reconciliation. Invoice creation alone is not proof of application credit.

## Still unproven

Browser execution, MCP initialize/tools discovery, progress notifications, browser refresh/reconnect, a persistent service identity, full application startup, GUI interaction, worker/build/verification, compatible preview, revisions, and pause/resume remain implementation and automated verification work. These probes do not satisfy the complete GUI objective.
