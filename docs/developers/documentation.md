# Maintain the documentation

The site is VitePress with an independent package/lockfile under `docs/`. Its URL prefix is **`/docs/`**. Keeping documentation dependencies separate avoids changing the development worker's pinned root manifest.

## Work locally

```sh
bun install --cwd docs --frozen-lockfile
bun run --cwd docs dev
```

Open the printed origin at `/docs/`. No Docker, model account or payment service is required for writing/building docs. Schema regeneration and integration examples additionally use the root dependencies.

## Choose the right audience

| Folder | Write for |
| --- | --- |
| `users/` | Someone creating/revising/publishing an applet and seeking answers |
| `operators/` | Someone installing, configuring accounts, hosting or maintaining the service |
| `implementers/` | Someone calling the CVM or connecting an MCP host |
| `developers/` | Someone changing this repository or implementing a compatible service |
| `runbooks/` | Detailed operational procedures and evidence boundaries |

Lead with the task and expected result. Define unfamiliar terms, link the glossary, and label unsupported/deferred capabilities honestly. Keep private account setup out of ordinary user instructions. Verify commands against the source and installed dependency exports.

## Links and navigation

Add pages to the matching sidebar in `.vitepress/config.mts`. Use relative links between pages or site-absolute Markdown links such as `/users/quick-start`; VitePress applies the `/docs/` base. Do not hardcode `/docs/docs/` or machine-local paths. Repository source links should point to GitHub, not `../../src` outside the docs tree.

Keep headings stable because other pages may link to their fragments. Downloadable schema JSON lives in `public/contracts/`. Do not put credentials or private examples anywhere under `public/`.

## Schema/reference changes

Run `bun docs/scripts/export-contracts.ts` after changing a validator. The generated catalog records structural constraints from the actual boundary schemas. Maintain prose for refinements and stateful checks that JSON Schema cannot express. `--check` verifies drift without rewriting files.

Examples under `examples/contextvm/` are executable source, not pseudocode presented as working code. Keep their smoke checks and MCP compatibility tests current when changing SDK pins or response shapes.

## Build, review and deploy

```sh
bun run --cwd docs build
bun run --cwd docs check:links
bun run --cwd docs preview
```

Review the built `/docs/` site, including search and narrow layouts. Restart the preview server after a rebuild so it picks up the new hashed assets. With the browser test dependencies and Chromium installed, `bun docs/scripts/check-browser.ts` checks the running preview (default `http://127.0.0.1:4173/docs/`; override `DOCS_URL`). It tests 35 page/viewport combinations down to 280 pixels, search, mobile navigation, sidebars and direct reloads, and writes screenshots under `.local/docs-evidence/`. The documentation workflow builds, checks links/schema drift and uploads a prefix-ready artifact. Use [static hosting](../operators/static-hosting#build-the-documentation-at-docs) to mount it alongside the website. The workflow does not provision a public host.

The original runbooks remain part of the site. Update stale scope statements when adding integration coverage; keep historical evidence identifiable rather than presenting it as a current production guarantee.
