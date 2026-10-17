# Create and revise

## Write a focused prompt

Describe the applet’s purpose, its main action, and what should appear on screen. Add details that affect behavior: keyboard controls, small-screen layout, empty states, or whether a reset needs confirmation.

The workspace accepts text ideas and revisions up to 512 characters. Direct CVM clients have a 4,000-character service limit. A napplet is a small, single-purpose applet; a large multi-service application is outside the generation contract.

## Revise the version you can see

Return to the latest verified version, then send a revision. Older versions are available for comparison; the current workspace does not branch a revision from an older selection. The service checks the expected version so two conflicting edits cannot silently overwrite each other. If the version changed, refresh the project and review the latest result before resubmitting.

Useful revisions describe the defect and the desired result:

> Keep the ball inside the visible play area at every supported screen size. Add padding at the top and bottom.

Avoid resending the entire original idea unless you intend a broader redesign. Revisions start from authorized, verified prior source.

## Read the execution state

| State | What to do |
| --- | --- |
| Model request or build running | Wait; use the live details to see the current stage. |
| Verified preview ready | Test it, select a version, revise, or publish. |
| Saved action needs funding | Fund the required amount, then explicitly resume. Funding alone does not start it. |
| Attempt failed | Read the reason. Your previous verified version remains available. |
| Outcome unconfirmed | Check status before retrying; work or its usage may still need reconciliation. |

The development subscription path can close a durably ended, unrecoverable attempt without a local test charge. When the UI says you can send again, the next submission is a new attempt; it is not an automatic retry of the old one.

## Disabled controls

The revision area explains its blocking condition: a request is running, there is no selected verified version, a saved request needs recovery, or the session requires attention. Use its suggested action. Signing in again is useful only for an actual signer or provider authentication problem.

## Understand preview visibility

Verified development builds receive a CVM-signed preview event and publicly readable, hash-addressed blobs on its Blossom service. Private project listings protect access to your CVM records; they do not make those shared preview bytes private. Reachability depends on the operator’s relay/Blossom setup.
