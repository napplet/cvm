# Remix and explore

## Start from an address

1. Choose **Remix an applet** on the creation page.
2. Paste the applet’s `naddr`. An npub, ordinary URL, or event ID is not a substitute.
3. Wait for the applet and its single-file asset to be found and verified.
4. Describe the change you want, then continue through creation.

Validation and browsing do not make model requests. Generation starts when you explicitly create the remix.

## What gets reused?

The client checks the signed applet event and the file’s hash. If the applet includes a supported source link, the CVM attempts to retrieve it in an isolated worker. The current importer supports public GitHub repositories. If source cannot be used, verified HTML is the fallback when it fits the input limit.

The interface tells you which basis was used. A source tag is a link supplied by the applet author; it does not prove that the repository produced the published file.

Published HTML can be fetched up to 2 MB. HTML supplied as model context is limited to 128 KB, so larger applets need usable source. Source import does not run repository installation scripts.

## Browse your network

Open **Explore** and choose **Your published applets** or **Your network**. Network browsing considers up to 100 people you directly follow. Discovery searches authors’ publishing relays, so unavailable relays or missing relay lists can leave results incomplete.

Use **Refresh** or **Show older applets** to make another lookup. Select **Remix this** to bring an address into the creation flow, or **Copy naddr** to use it elsewhere.

Explore shows public published events. **Your applets** shows private CVM project records, including drafts and unfinished work. An unpublished draft belongs in Your applets, not Explore.

Respect the source project’s license and attribution requirements when adapting someone else’s work.
