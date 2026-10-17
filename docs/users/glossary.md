# Glossary

## Napplet

A small, single-purpose web applet that runs inside a compatible Nostr shell. It asks the shell for capabilities such as storage rather than taking unrestricted browser access.

## applet.broker

The user-facing workspace for creation, preview, revisions, browsing and publication.

## CVM / ContextVM

ContextVM carries MCP messages over Nostr. Here, “the CVM” means the napplet generation service identified by its public key. The term does not mean the website needs a traditional HTTP application backend.

## MCP

Model Context Protocol: a way for clients and tools to discover and call capabilities. A local proxy can expose this remote CVM to an ordinary MCP host.

## Nostr identity, npub, and signer

An npub is a human-readable public key. A signer holds or accesses the corresponding private key and approves signed events. The CVM derives private project access from the key that signs the request, not an npub typed into a form.

## NIP-07 and NIP-46

NIP-07 connects a website to a browser extension signer. NIP-46 connects it to a remote signer, commonly paired by scanning a NostrConnect QR code.

## nbunksec

A serialized NIP-46 connection credential stored locally for reconnecting. It includes the client session key, not the remote user’s signing key. Treat it as a secret.

## Relay and outbox

A relay carries Nostr events. An author’s outbox relays are the places they publish events; discovery uses their relay list to look there.

## Blossom

A protocol for storing and retrieving files by content hash. Publication copies verified applet files to the user’s Blossom servers.

## naddr

An encoded address for a replaceable Nostr event. It identifies an applet event; it is not the applet file itself or a secret.

## Version, artifact, and preview

A version is a successful iteration. Its artifact is the sealed, verified build output. A preview opens that output in a compatible sandboxed shell.

## Cashu, NWC, and sat

Cashu is an ecash payment system. NWC (Nostr Wallet Connect) lets a wallet receive payment commands over Nostr. A sat is a small bitcoin denomination. The local development stack uses test sats.

## Admission, hold, and idempotency

Admission reserves capacity and funds before work starts. A hold reserves an amount without necessarily charging it. Idempotency means replaying the same authorized operation does not intentionally create another charge or model request.
