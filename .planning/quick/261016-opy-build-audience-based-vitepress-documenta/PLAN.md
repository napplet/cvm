---
status: complete
workflow: gsd-quick (inline; comprehensive documentation goal)
---

# Audience-based documentation at /docs/

Deliver a built, searchable, responsive VitePress site, with separate paths for users, advanced users/operators, implementers, and developers. Preserve existing runbooks and connect them to task-oriented guides. Documentation must distinguish working development features from deferred production work and unsupported model endpoints.

## Work

1. Inspect source, tool schemas, provider configuration, local deployment, tests, and installed ContextVM packages. Verify current upstream MCP proxy and VitePress instructions against primary sources.
2. Build an isolated docs package, /docs/ base, audience navigation, local search, brand styling, build/preview commands and CI/static deployment guidance.
3. Write user walkthroughs, concepts, FAQ and troubleshooting; operator self-hosting, own-provider/local-model guidance, configuration, hosting, backup and security.
4. Write implementer CVM and MCP guides with executable examples and authoritative tool/schema references; developer architecture, contribution/testing, compatible CVM implementation, schema rationale and a GitHub amendment process/template.
5. Build with strict links, test runnable integration/proxy examples without generation spend, audit schema/config claims against source, and inspect rendered navigation/search/mobile/base-path behavior. Commit/push and complete the goal only after every audience and explicit deliverable has evidence.

## Acceptance evidence

- /docs/ routes and assets work from an arbitrary static origin; local search and audience sidebars work on desktop/mobile.
- A user can create, revise, sign in, recover, browse/remix, preview/share/publish, understand costs/limits and find common answers.
- An operator can start the actual stack, choose private credentials, understand local-model support precisely, host the static site, and maintain state.
- A client implementer can connect through native CVM or local stdio MCP and discover/invoke tools under a verified identity. Examples match pinned package exports and live tool contracts.
- A developer can contribute or build a compatible CVM, explain field/schema choices, and submit a concrete schema change through GitHub.
- Strict docs build, link/anchor audit, example checks, and requirement-by-requirement completion audit pass. Production certification remains deferred, not a documentation blocker.
