# Identity and saved projects

**Sign in** is available at the beginning, between steps, and while generation is running.

| Choice | What it uses | What persists |
| --- | --- | --- |
| Anonymous | A temporary key kept in this browser tab | Reloads in that tab; closing the tab may lose access. |
| NIP-07 | A compatible Nostr browser extension | The selected method is remembered; the extension’s public key is read again on return. |
| NIP-46 | A remote signer paired through a NostrConnect QR code | A local `nbunksec` connection record reconnects the same signer on return. |

NIP-07 is disabled when no extension is detected. For private CVM requests, the extension also needs NIP-44 support. With NIP-46, scan the QR code or use **Open signer**, then approve the connection in your signer.

<GuideScreenshot name="sign-in" alt="Sign-in dialog offering Anonymous, a disabled NIP-07 extension option and NIP-46 remote signer" caption="Choose a signing method. NIP-46 opens a QR code below these controls; use the code in your own workspace." />

## Returning to the workspace

On the same site and CVM, NIP-07 and NIP-46 sign-in survive reloads and browser restarts. If an extension is locked or a remote signer is offline, unlock/open it and use **Reconnect saved signer**. You normally do not need another QR pairing.

**Sign out** removes the saved connection and updates other tabs. Clearing site data, using another origin, or revoking the remote connection requires signing in again. The CVM never receives your Nostr private key.

## Find your work

Open **Your applets** in the primary navigation. Filter by stage or refresh the list. Open a project to restore its verified versions without generating again.

- **Your account** contains projects created by the selected signed identity.
- **This browser** contains projects owned by the original anonymous browser key.

<GuideScreenshot name="projects" alt="Your applets page showing Ready and Building projects, with Your account and This browser ownership labels" caption="Find unfinished and ready applets together. Each card shows its stage and the identity scope that owns it." />

Signing in during an anonymous build does not transfer ownership. That build continues under its original key, while new builds use your selected identity. Sign in before starting a new project when cross-browser recovery matters.

The service checks the key that actually signed each request. Entering or knowing someone else’s npub does not let you retrieve their private projects.

## Nostr sign-in versus model sign-in

Your Nostr signer identifies you to the CVM and signs your publication. ChatGPT/OAuth and API credentials belong in the private **CVM admin**, controlled by the operator. They do not appear in the public workspace.
