# Publish and share

There are two ways to share a verified applet.

| Action | Who signs the applet event? | Use it for |
| --- | --- | --- |
| Copy preview naddr | The CVM | Trying a build in another compatible shell. |
| Publish | Your selected Nostr identity | Publishing the chosen version as your applet. |

An `naddr` identifies a replaceable Nostr event. A shell still needs access to the event’s relays and the applet’s Blossom files. Local development addresses may work only on the same machine until the operator exposes reachable services.

## Publish your selected version

1. Select a verified version. **Publish** appears beside the applet and stays disabled until a signing identity is selected.
2. Open the final **Publish** step. Give the applet a name and review its destinations.
3. Approve signing in your extension or remote signer.
4. Follow file propagation. The browser mirrors the CVM’s verified files to your Blossom servers, falling back to verified upload where necessary.
5. Wait for relay confirmation, then **Copy naddr**.

The applet event is signed before file propagation. It is published only after the required copies are verified. The CVM prepares the event, but your signer owns the publication signature.

## Choose destinations

The workspace discovers your Blossom server list and your NIP-65 publishing relays. Relay-list discovery uses purplepag.es. If a list is missing or unusable, enter destinations manually.

Type a URL and press **Enter** to turn it into a removable chip. Use `https://` for public Blossom servers and `wss://` for public relays. Relay suggestions are advisory; review and select your own destinations.

## If a step fails

Progress shows signing, each file copy, verification, and each relay result. **Retry remaining steps** checks existing copies and reuses the signed applet event. It does not ask the model to rebuild the applet.

If relay confirmation is uncertain, use **Check publication**. Avoid creating a different publication just because a relay response was delayed.

The development server’s own Blossom store accepts writes only from the CVM. Publishing to your own servers is what makes the final files independent of that store.

## Returning to a published applet

A current UI issue can leave the builder/project display unchanged after a successful publication. Keep the confirmed naddr and open it in a compatible shell to check the published version. Repeating publication just to change the builder's label is unnecessary. Persistent publication tracking and the publishing section's design are follow-up work; the status shown in the builder is not yet a reliable publication history.
