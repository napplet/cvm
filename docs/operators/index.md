# Self-host and operate

Start with the **local development stack**. It brings up the CVM, static workspace, database, relay, Cashu mint, NWC wallet, isolated worker and preview host. You do not need real funds or a model account for your first test.

| Your goal | Start here |
| --- | --- |
| Try it on your computer | [Local installation](./quick-start) |
| Generate with your own account | [Accounts and providers](./providers) |
| Use Ollama, llama.cpp or another local endpoint | [Current support and extension path](./local-models) |
| Put the website on a separate host | [Static hosting](./static-hosting) |
| Inspect jobs, preserve data or update | [Operations and backups](./operations) |
| Understand the trust boundaries | [Security](./security) |

The product website is static. It sends signed, encrypted CVM requests through Nostr; model accounts and API keys stay with the CVM operator. Hosting the website alone does not start a CVM.

This repository currently delivers a development deployment. Production certification and managed-infrastructure adapters remain [explicitly deferred](../runbooks/production-readiness-deferred). That does not prevent local development, publishing test applets, or integrating the protocol.
