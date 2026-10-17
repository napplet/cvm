---
layout: home
hero:
  name: applet.broker
  text: A little applet. A lot you can do.
  tagline: Learn to create Nostr applets, run your own service, connect your tools, or build a compatible CVM.
  actions:
    - theme: brand
      text: Make your first applet
      link: /users/quick-start
    - theme: alt
      text: Run it yourself
      link: /operators/quick-start
features:
  - title: Use the workspace
    details: Describe an idea, make changes, find your projects, and share an applet. Plain-language guides and answers to common questions.
    link: /users/
    linkText: User guide
  - title: Bring your own setup
    details: Host the CVM and static website, connect private provider accounts, understand local-model support, and keep your data safe.
    link: /operators/
    linkText: Self-hosting guide
  - title: Connect your application
    details: Call the service over ContextVM or connect an MCP client. Understand identity, tools, payments, progress, and retries.
    link: /implementers/
    linkText: Integration guide
  - title: Build and contribute
    details: Explore the architecture, implement a compatible CVM, understand the schema, and propose changes through GitHub.
    link: /developers/
    linkText: Developer guide
---

## What are we building?

**applet.broker** is the workspace. **napplet-cvm** is the service behind it. Together they turn a focused idea into a small, sandboxed Nostr applet, with a preview, revisions, and publication under your identity.

The website is static. Service commands travel through signed, encrypted **ContextVM** messages over Nostr relays. Provider credentials stay with the service operator.

::: info Current status
This repository provides a working local development environment. The default model is a clearly labeled deterministic sample; an operator can enable real generation. Production certification is deferred. Start with [local installation](/operators/quick-start) if you do not already have access to a workspace.
:::

## Find an answer

- [What is a napplet?](/users/glossary#napplet)
- [Why did generation stop?](/users/troubleshooting)
- [Where are my saved applets?](/users/identity-and-projects)
- [How do I publish or copy an naddr?](/users/publish-and-share)
- [Can I use my own account or a local model?](/operators/providers)
- [How do I use this from an MCP client?](/implementers/mcp)
- [How do I propose a schema change?](/developers/schema-changes)

Use search in the navigation to find a feature, error code, or command.
