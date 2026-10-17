# Frequently asked questions

## Do I need to sign in before trying it?

No. You can start anonymously and sign in at any time. For projects you want to recover in another browser, sign in before starting. Signing in later does not transfer an anonymous project.

## Do I have to log in every time?

No. NIP-07 rechecks the extension’s public key, and NIP-46 reconnects from a local saved session. You may need to unlock your signer. Clearing browser data or revoking a remote connection requires sign-in again.

## Why does it keep producing a sample applet?

Check the provider label. **Deterministic fixture** is a development sample with no model request. The CVM operator needs to activate a real provider in the private admin.

## Can I enter my ChatGPT account in the website?

Provider credentials are private to the CVM. If you operate it, use CVM admin. Your public workspace sign-in is for Nostr identity and publication, not model access.

## Where is my project?

Open **Your applets**. Check both your signed account and **This browser** projects. A project made anonymously is attached to the original tab’s key. Explore lists published applets, not private drafts.

## Can I browse while a build runs?

Yes. The application keeps the builder mounted and shows running work in its navigation. Signing in does not change the identity of the in-flight request.

## Does refreshing regenerate my applet?

Opening a saved project or restoring its preview does not generate another version. If an action was interrupted, use the offered recovery/status action and read its outcome before sending a new request.

## Why can’t I publish?

Choose a signing identity and a verified version. The contextual Publish button then opens the final creation step. A failed build or a pending signer connection is not publishable.

## Why does my naddr work here but not on my phone?

The phone must reach the relay and Blossom server that hold the applet. Loopback development addresses point at each device itself. Ask the operator to configure reachable services, or publish to your own reachable destinations.

## Can I use a local model?

There is no ready-made Ollama, LM Studio, or arbitrary base-URL configuration in this revision. See [local models](/operators/local-models) for the actual support boundary and the adapter path.

## Is there a public production service or npm package to install?

The checked-in workflow is local development from source. Production certification remains deferred, and the repository does not establish a published `@napplet/cvm` package. Follow [installation](/operators/quick-start) rather than guessing a package command.
