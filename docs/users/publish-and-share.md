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

<GuideScreenshot name="publish-review" alt="Publication review for Version 2 with destinations expanded and the Sign and publish button above three publication stages" caption="Review the version and destinations before approving your signer. Preparing this review does not publish anything." />

## Choose destinations

The workspace discovers your Blossom server list and your NIP-65 publishing relays. Relay-list discovery uses purplepag.es. If a list is missing or unusable, enter destinations manually.

Type a URL and press **Enter** to turn it into a removable chip. Use `https://` for public Blossom servers and `wss://` for public relays. Relay suggestions are advisory; review and select your own destinations.

<GuideScreenshot name="publish-destinations" alt="Final Publish step with an applet name and removable Blossom-server and relay URL chips" caption="When discovery finds no list, add your own destinations. The example.com addresses shown here are placeholders; replace them with your servers." />

## If a step fails

Progress shows signing, each file copy, verification, and each relay result. **Retry remaining steps** checks existing copies and reuses the signed applet event. It does not ask the model to rebuild the applet.

If relay confirmation is uncertain, use **Check publication**. **Destination details** shows which copies or relays need attention. **Retry remaining steps** rechecks existing files and resends the same signed event where needed.

The CVM saves your applet signature before copying starts, along with file-copy results and relay confirmations as each attempt finishes. You can reload or reopen the project and continue publishing. You may still need to approve file-copy permission in your signer; the applet itself keeps its original signature.

The development server’s own Blossom store accepts writes only from the CVM. Publishing to your own servers is what makes the final files independent of that store.

## Returning to a published applet

The builder shows **Published · Version N** and changes **Publish** to **View publication**. Open it to see the saved confirmations or copy the same naddr. Publication status comes from the CVM, so it survives a page reload or service restart.

<GuideScreenshot name="publish-confirmed" alt="Completed publication with three confirmed stages, Version 2 destination counts, an applet address and Copy naddr button" caption="A completed publication stays available from View publication. Copy naddr opens the same published version in another compatible shell." />

**Your applets** also shows the published version. After a successful revision, it shows **Unpublished changes** and identifies both the published version and the newer version ready to publish. Revising does not publish automatically. You can select an older version above the preview to return to its publication.

An applet started anonymously stays with its original browser identity even if you publish it using another signer. Signing a publication does not transfer ownership of the saved project; return with the identity that created it, or the same browser tab for an anonymous build.
