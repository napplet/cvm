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

## User-guide screenshots

Illustrate tasks with the current application controls, useful alternative text, and a caption explaining what to do. Use the shared component so images scale down, reserve their layout space and open at full size:

```md
<GuideScreenshot name="create" alt="Creation page with a prompt and the Shape my idea button" caption="Describe one focused applet, then continue." />
```

Regenerate the committed PNG files and their dimensions under `public/images/users/` when the workspace changes:

```sh
bun install --frozen-lockfile
bun install --cwd tests/dev-ui --frozen-lockfile
./tests/dev-ui/node_modules/.bin/playwright install chromium
bun docs/scripts/capture-user-screenshots.ts
```

The capture script renders the real workspace components and stylesheet in isolated Chromium with disposable sample data. CVM responses, discovery results and execution stages are simulated; the preview contains a sample counter. These screenshots explain the interface and are not end-to-end evidence. The script blocks external HTTP/WebSocket traffic, rejects generation/signing/publication effects and needs no Docker, live CVM or model account. It does not connect to the user's running development service.

The sign-in crop excludes the generated connection QR. Never capture a live account, pairing URI, `nbunksec`, token or private project for public documentation. Use reserved example domains for publication destinations. Captions identify sample screens and placeholder addresses; keep those distinctions when adding images.

Inspect every regenerated image for clipped controls or stale copy, then run the built-site browser check below. Do not retouch screenshots into a UI that the application does not actually render.

## Schema/reference changes

Run `bun docs/scripts/export-contracts.ts` after changing a validator. The generated catalog records structural constraints from the actual boundary schemas. Maintain prose for refinements and stateful checks that JSON Schema cannot express. `--check` verifies drift without rewriting files.

Examples under `examples/contextvm/` are executable source, not pseudocode presented as working code. Keep their smoke checks and MCP compatibility tests current when changing SDK pins or response shapes.

## Build, review and deploy

```sh
bun run --cwd docs build
bun run --cwd docs check:links
bun run --cwd docs preview
```

Review the built `/docs/` site, including search and narrow layouts. Restart the preview server after a rebuild so it picks up the new hashed assets. With the browser test dependencies and Chromium installed, `bun docs/scripts/check-browser.ts` checks the running preview (default `http://127.0.0.1:4173/docs/`; override `DOCS_URL`). It tests 70 page/viewport combinations down to 280 pixels, screenshot loading and full-size links, search, mobile navigation, sidebars and direct reloads, and writes screenshots under `.local/docs-evidence/`. The documentation workflow builds, checks links/schema drift and uploads a prefix-ready artifact. Use [static hosting](../operators/static-hosting#build-the-documentation-at-docs) to mount it alongside the website. The workflow does not provision a public host.

The original runbooks remain part of the site. Update stale scope statements when adding integration coverage; keep historical evidence identifiable rather than presenting it as a current production guarantee.
