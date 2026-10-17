# Publish and share

There are two ways to share a verified applet.

| Action | Who signs the applet event? | Use it for |
| --- | --- | --- |
| Copy preview naddr | The CVM | Trying a build in another compatible shell. |
| Publish | Your selected Nostr identity | Publishing the chosen version as your applet. |

An `naddr` identifies a replaceable Nostr event. A shell still needs access to the event’s relays and the applet’s Blossom files. Local development addresses may work only on the same machine until the operator exposes reachable services.

## Publish your selected version

1. Select a verified version. **Publish** appears beside the applet and stays disabled until a signing identity is selected.
2. Open the final **Publish** step. Review the title and description suggested by the CVM, edit them if needed, and choose destinations.
3. Approve signing in your extension or remote signer.
4. Follow file propagation. The browser mirrors the CVM’s verified files to your Blossom servers, falling back to verified upload where necessary.
5. Once any selected relay confirms, choose **Copy naddr**. Other relays can remain unavailable.

The applet event is signed before file propagation. It is published once all files have verified copies on at least **two distinct Blossom servers**. An extra server failing does not block publication. **One confirmed relay is enough**; every selected relay does not need to succeed. The CVM prepares the event, but your signer owns the publication signature.

<GuideScreenshot name="publish-review" alt="Publication review for Version 2 with destinations expanded and the Sign and publish button above three publication stages" caption="Review the version and destinations before approving your signer. Preparing this review does not publish anything." />

## Review applet details

The CVM suggests a title and description from verified manifest metadata, falling back to your saved project for older builds. This uses no extra model request. Both fields stay editable until signing; the review shows the exact text you will sign.

Open **Advanced applet details** to see **Required** and **Optional** shell capabilities, plus the manifest and file hashes. Older builds cannot declare optional capabilities, so they show **Not declared by this build**. This does not mean the applet has no optional integrations. These declarations come from the verified build and are read-only here.

<GuideScreenshot name="publish-advanced" alt="Publication review with Required and Optional capability sections expanded under Advanced applet details" caption="Check capability declarations before signing. Older manifests explicitly identify missing optional declarations." />

## Choose destinations

The workspace discovers your Blossom server list and your NIP-65 publishing relays. Relay-list discovery uses purplepag.es. If a list is missing or unusable, enter destinations manually.

Choose two to five Blossom servers and at least one publishing relay. Type a URL and press **Enter** to turn it into a removable chip. Use `https://` for public Blossom servers and `wss://` for public relays. Relay suggestions are advisory; review and select your own destinations.

<GuideScreenshot name="publish-destinations" alt="Final Publish step with an applet name and removable Blossom-server and relay URL chips" caption="When discovery finds no list, add your own destinations. The example.com addresses shown here are placeholders; replace them with your servers." />

## If a step fails

Progress shows signing, file copies and relay delivery. **Delivery details** contains individual results. If at least two servers have complete verified copies, publishing continues and additional failures remain visible as warnings. The completion summary counts verified file copies and confirmed relays only.

With fewer than two complete copies, publishing waits. For example, HTTP 401 means that server rejected the copy authorization; its address can be valid even though it does not accept your upload. **Retry file copies** checks existing copies and reuses the signed applet event. You can also choose **Edit details and destinations** to remove an unusable server and add another. It does not ask the model to rebuild the applet.

If no relay has confirmed, use **Retry publication** or edit your relays. Saved file copies and your signature are reused. **Check publication** looks for the existing event. Once one relay confirms, the applet is published; unavailable extras remain in collapsed **Delivery details**. Older attempts with saved confirmations are corrected automatically when the CVM starts or the attempt is reopened.

Editing an unfinished signed publication creates a replacement draft and requires a **fresh signature**. The CVM retains the previous signed event in history and reuses verified copies for unchanged destinations. A previous event may already have reached a relay when confirmation was lost; editing cannot retract it.

The CVM saves your applet signature before copying starts, along with file-copy results and relay confirmations as each attempt finishes. You can reload or reopen the project and continue publishing. You may still need to approve file-copy permission in your signer; the applet itself keeps its original signature.

The development server’s own Blossom store accepts writes only from the CVM. Publishing to your own servers is what makes the final files independent of that store.

## Returning to a published applet

The builder shows **Published · Version N** and changes **Publish** to **View publication**. Open it to see the saved confirmations or copy the same naddr. Publication status comes from the CVM, so it survives a page reload or service restart.

<GuideScreenshot name="publish-confirmed" alt="Published applet with Copy naddr and Republish buttons, two file copies and one confirmed relay; unavailable destinations are in collapsed delivery details" caption="Two file copies and one confirmed relay are enough. Extra failures stay in delivery details; your applet is ready to share." />

**Republish** is available beside **View publication** and on the publication result. It sends the same signed applet to your saved relays again, keeping the same naddr. Files, signatures and model generation are reused. Progress changes to **Republishing…**, then reports the new confirmations. If the resend cannot confirm, your earlier publication remains saved.

**Your applets** also shows the published version. After a successful revision, it shows **Unpublished changes** and identifies both the published version and the newer version ready to publish. Revising does not publish automatically. You can select an older version above the preview to return to its publication.

An applet started anonymously stays with its original browser identity even if you publish it using another signer. Signing a publication does not transfer ownership of the saved project; return with the identity that created it, or the same browser tab for an anonymous build.
