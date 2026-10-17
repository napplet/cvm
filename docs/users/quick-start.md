# Your first applet

## 1. Open the workspace

Wait for **Workspace connected**. If you are running the local service, use the URL printed by `bun scripts/dev.ts up`; its port may differ between installations.

Check the provider label. **Deterministic fixture** builds a sample. A real provider must be configured by the operator for your prompt to drive generation.

## 2. Describe one useful thing

Choose **New idea**, then enter a focused request:

> A reading-session counter with Add and Reset buttons. Show today’s total in large text and use a quiet green theme.

<GuideScreenshot name="create" alt="Creation page with the reading-counter prompt entered and the Shape my idea button" caption="Start with one focused idea. Your applets and Explore remain available in the top navigation." />

Choose **Shape my idea**, review the setup and maximum, then **Create my applet**. Local development prepares test funds automatically. You do not need a real wallet for those test sats.

<GuideScreenshot name="setup" alt="Ready to build step showing the idea, connected CVM, expanded test budget and Create my applet button" caption="Review the connected CVM and open the test-budget details before creating. The example uses fixture mode." />

## 3. Follow the build

The workspace reports admission, model work, response receipt, the isolated build, checks, and preview readiness. Keep the tab open while it works. You can sign in or visit your collection during a build; those actions do not move the build to another identity.

<GuideScreenshot name="build-progress" alt="Build progress at Checking, following Preparing, Generating and Building, with Preview still ahead" caption="The stage strip tells you what is happening now. This example is checking the applet." />

While the first version is building, the empty preview shows the current operation, elapsed time, approximate remaining time and estimated cost. The stage strip stays above it. During revisions, your last verified preview remains available and live details stay above the workspace.

<GuideScreenshot name="preview-status" alt="Empty preview showing Checking everything works with a quiet geometric loader, current operation, elapsed time, estimated remaining time and test-sat cost" caption="Follow the first build in the preview pane. These timings are estimates from your CVM history, not deadlines." />

If it stops, read the explanation beside the action or open the execution details. See [troubleshooting](./troubleshooting) before starting another request.

## 4. Try it and improve it

Use the preview as you would the applet. In the revision box, describe a specific change, such as “Ask before resetting the counter.” Send it with the arrow or **⌘/Ctrl + Enter**.

A successful revision creates a new verified version. Use **Version history** to view earlier builds. Choose **Restore this version** to continue editing from one, without another model request or charge. [Learn about revisions](./create-and-revise#load-or-restore-an-earlier-revision).

<GuideScreenshot name="revise" alt="Reading counter preview beside a request to ask for confirmation before resetting, with Version 2 selected" caption="Test the preview, then send one specific change. The version picker is above the preview." />

## 5. Keep or share your work

Sign in before starting if you want the project attached to an identity you can use on another browser. Anonymous work stays with this browser tab’s key.

Use **Copy preview naddr** to test a CVM-owned preview in a compatible shell, or follow the final **Publish** step to publish under your identity. [Understand the difference](./publish-and-share).
