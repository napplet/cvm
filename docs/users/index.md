# Use applet.broker

Make one small app that does something useful: a reading counter, a focused timer, a personal list, or a simple game. Describe what you want, try the preview, and ask for changes.

You need a workspace connected to a running CVM. If you already have its website address, open it. If you are setting up the service yourself, follow [local installation](/operators/quick-start).

## Start with a task

| I want to… | Read |
| --- | --- |
| Make my first applet | [Your first applet](./quick-start) |
| Change an existing build | [Create and revise](./create-and-revise) |
| Find something I made before | [Identity and saved projects](./identity-and-projects) |
| Adapt someone else’s applet | [Remix and explore](./remix-and-explore) |
| Test it in another shell or publish it | [Publish and share](./publish-and-share) |
| Understand a charge or a limit | [Costs and limits](./costs-and-limits) |
| Understand a word or an error | [Glossary](./glossary), [troubleshooting](./troubleshooting) |

## What happens to your idea?

The CVM asks its configured model for applet source, builds it in an isolated worker, checks the result, and opens a verified preview. The live execution panel shows actual stages. A moving loader means a lookup is in progress; it is not a percentage complete.

Your Nostr identity controls your saved projects and publication. The model account belongs to the CVM operator. These are separate sign-ins.

::: tip Trying the development workspace
The default **Deterministic fixture** creates a sample applet without asking a model. To generate from your own ideas, the operator must enable a real provider in CVM admin.
:::
