# Security boundaries

## Identity and private state

The CVM verifies the signed request and uses its public key as the caller identity. A request body cannot choose another owner. Project IDs, account IDs, session IDs and a known npub are references, not authorization.

Users' signing keys remain in their extension or remote signer. NIP-46 restoration stores a local `nbunksec` credential in browser storage; treat that as a session secret. Operator model accounts live in the CVM's private vault, separate from users' Nostr authentication. The static site contains neither those accounts nor an admin signer.

<GuideScreenshot audience="operators" name="access" alt="Operator-only access form with a blank private key field and Connect to CVM button" caption="Admin access uses the CVM operator credential. Signing in to the public workspace does not grant these controls." />

## Untrusted generated code

Prompts, imported repositories, model output and build tools are untrusted. The coordinator checks bounded inputs and allowed application paths. The worker uses a pinned toolchain, offline dependencies, resource/time limits and an isolated filesystem. Preview is a sandboxed applet with an explicit capability policy, not arbitrary code running with the parent page's privileges.

Remix source is checked out in a separate restricted process/container. Current imports restrict supported source locations and size; importing a signed applet is not permission to execute its repository on the coordinator. Keep these boundaries when adding providers or source hosts.

## Publication

Only the CVM's own upload authorizations can write to its Blossom service. Public blobs can be fetched by hash. User publication requires a client-signed applet event and verified copies at the chosen destinations; the CVM cannot sign as the user.

A signature establishes the event author, not that its applet is harmless. Use compatible sandboxing shells and preserve the conformance gates.

## Report a problem

Open a [GitHub issue](https://github.com/napplet/cvm/issues/new) for non-sensitive defects with the revision, safe error code and reproduction steps. For credential exposure or an exploitable vulnerability, use the repository's private security-reporting option if enabled; otherwise ask maintainers for a private channel before sending details. Never attach keys, OAuth tokens, `nbunksec`, private state directories or raw provider bodies to a public issue.
