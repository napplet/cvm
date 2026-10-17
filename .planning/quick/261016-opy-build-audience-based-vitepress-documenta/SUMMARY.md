# Audience-based documentation — complete

Built a standalone VitePress 1.6.4 site with `/docs/` base, warm light/dark theme, local search, four audience paths and integrated existing runbooks. 37 content pages plus 404. Local preview: http://127.0.0.1:4173/docs/ (separate from the user's running CVM; no restart or generation required).

## Requirement audit

| Requirement | Delivered evidence |
| --- | --- |
| Users can use the product and find answers | Ten user pages: first applet, revisions, identity/returning projects, remix/discovery, publish/share, limits, FAQ, troubleshooting and glossary; homepage answer links and full-text search |
| Advanced users can self-host with their own accounts | Eight operator pages: real local setup, private OAuth/API admin, exact configuration, separate static hosting, backup/update operations and security |
| Honest local-model guidance | Dedicated page explains there is no current arbitrary baseURL/local provider option and gives the ModelGateway/receipt/accounting implementation and test path; no invented setup commands |
| Native CVM integration | Executable stable-client-identity example verified against the running signed/encrypted CVM; service/account/project reads with no generation |
| MCP integration using ContextVM JS | Installed SDK 0.13.10 NostrMCPProxy and MCP SDK 1.30.0 stdio example; compatibility for actual name-only discovery and domain-result wire shape; read-only defaults and explicit generation opt-in |
| Tool/schema reference | 16 tool input schemas generated from runtime validators, including remix asset-part staging; session result/status/progress and operator profile/card schemas; drift check in CI |
| Developers/contributors/new CVMs | Seven developer pages cover architecture, compatible implementation invariants, rationale, contribution/testing and docs maintenance |
| Clear amendment path | GitHub schema-amendment issue form, process guide, compatibility/migration/authority questions and CONTRIBUTING entry |
| Static `/docs/` site | Independent package/lock; correct asset/link prefix; deployment instructions and CI artifact containing a top-level docs directory |
| Production does not block development | Current local capabilities distinguished from deferred certification; historical runbook scope corrected and source links made usable in VitePress |

## Verification

- `bun run --cwd docs build`: pass, strict dead-link check enabled.
- `bun run --cwd docs check:links`: 38 built HTML pages; 1,212 local links/assets/fragments verified.
- `bun docs/scripts/export-contracts.ts --check`: pass, 16 tools.
- Native `read-status.ts` and actual stdio `check-mcp.ts`: pass against current CVM. Discovery, three read calls, generation/rename denial; no model request/payment.
- 29 focused tests across MCP compatibility, ContextVM identity/funding/publication, operator, progress and remix: pass (224 assertions).
- Standalone strict TypeScript check for all integration example files: clean.
- Whole-repository TypeScript check: existing 424 diagnostics unchanged by file/error-code counts against a fresh HEAD checkout using the same TypeScript 5.9.3 and dependencies.
- Browser check: 35 page/viewport combinations (280, 320, 390, 768, 1280 px), local search, mobile navigation/sidebar, deep reload, dark/reduced-motion screenshots, no browser/resource errors. Evidence under ignored `.local/docs-evidence/`.
- `git diff --check`: pass. Root package/lock pins unchanged.

Runtime source changes only export/reuse existing input validators for the generated catalog; no validation semantics or service wire responses changed. The MCP compatibility layer lives in the examples, preserving existing clients. The docs build/preview does not depend on Docker or private credentials.

## Next task requested during documentation

User reported successful repeated publications not updating project/builder state, with a publishing section that needs to match the application design. User then explicitly said **finish the Docs first**. Documentation is completed first; publication persistence/projection/restoration and contextual design are the next task. The user guide records the current UI limitation without claiming a fix. No new publish was performed, and the user's running CVM was not restarted during documentation work.
