# Create and revise

## Write a focused prompt

Describe the applet’s purpose, its main action, and what should appear on screen. Add details that affect behavior: keyboard controls, small-screen layout, empty states, or whether a reset needs confirmation.

The workspace accepts text ideas and revisions up to 512 characters. Direct CVM clients have a 4,000-character service limit. A napplet is a small, single-purpose applet; a large multi-service application is outside the generation contract.

## Revise the version you can see

Send revisions from the version marked **current**. Each successful build adds a saved version. The service checks the saved project state so conflicting edits cannot silently overwrite each other.

Useful revisions describe the defect and the desired result:

> Keep the ball inside the visible play area at every supported screen size. Add padding at the top and bottom.

Avoid resending the entire original idea unless you intend a broader redesign. Revisions start from authorized, verified prior source. Review the compact **Next revision** cost and time footer below the composer before sending. Open **How this is estimated** for the history behind the range; [costs and limits](./costs-and-limits) explains how they are calculated.

<GuideScreenshot name="revision-composer" alt="Revision conversation with Version 2 ready and a filled change request beside the send arrow" caption="Write your change in the bottom field, then use the arrow or ⌘/Ctrl + Enter." />

## Load or restore an earlier revision

Open **Version history** above the preview, then choose **View** beside any saved version. The version picker also lets you switch previews. Viewing a version does not change your saved current version.

To continue from that revision, choose **Restore this version**. It becomes current immediately and stays current when you return to the applet. Your next revision uses its saved source. **Return to current** leaves comparison mode without restoring anything.

<GuideScreenshot name="revision-history" alt="Version history with version 2 marked Current, version 1 being previewed, and Restore this version and Return to current actions" caption="Compare any saved build, then choose which version your next edit should start from." />

Restoring makes no model request and adds no charge. It keeps later versions, unsent draft text, and the full cost history. Past charges are unchanged. You can restore another saved version again whenever you want.

Restoration is saved as a project change, so version numbers can skip: restoring version 1 after version 2 can make the next generated build version 4. Published events are unchanged until you explicitly publish again. Finish or check any running request before restoring.

## Read the execution state

| State | What to do |
| --- | --- |
| Model request or build running | Wait; use the live details to see the current stage. |
| Verified preview ready | Test it, select a version, revise, or publish. |
| Saved action needs funding | Fund the required amount, then explicitly resume. Funding alone does not start it. |
| Attempt failed | Read the reason. Your previous verified version remains available. |
| Outcome unconfirmed | Check status before retrying; work or its usage may still need reconciliation. |

The development subscription path can close a durably ended, unrecoverable attempt without a local test charge. When the UI says you can send again, the next submission is a new attempt; it is not an automatic retry of the old one.

<GuideScreenshot name="execution-details" alt="Expanded live execution showing reservation and build completion followed by guidance and TypeScript checks running" caption="Open Execution details beneath the builder for individual stages and their results." />

## Disabled controls

The revision area explains its blocking condition: a request is running, there is no selected verified version, a saved request needs recovery, or the session requires attention. Use its suggested action. Signing in again is useful only for an actual signer or provider authentication problem.

## Understand preview visibility

Verified development builds receive a CVM-signed preview event and publicly readable, hash-addressed blobs on its Blossom service. Private project listings protect access to your CVM records; they do not make those shared preview bytes private. Reachability depends on the operator’s relay/Blossom setup.
