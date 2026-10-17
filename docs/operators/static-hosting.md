# Host the static workspace and docs

The website can live on a different machine or domain from the CVM. Service commands use the configured Nostr relay and public service key. HTTP still delivers static pages, public blobs and preview assets.

## Export the workspace

After starting the default CVM:

```sh
bun scripts/build-workspace.ts
```

Serve `dist/workspace/` with your static host. For another CVM or named instance, provide the public connection document explicitly:

```sh
CVM_CONFIG=/absolute/path/to/cvm.json bun scripts/build-workspace.ts dist/workspace
```

The export contains the public workspace and connection settings; private admin stays with the CVM. The workspace supports a subdirectory. Preserve the generated asset paths and `cvm.json`.

## Make the CVM reachable

A remote browser cannot connect to your computer's `127.0.0.1`. Expose the **existing** relay and Blossom listener through reachable endpoints, then set these before starting the service:

```sh
export NAPPLET_CVM_PUBLIC_RELAY_URL=wss://relay.example.org
export NAPPLET_CVM_BLOSSOM_PUBLIC_URL=https://blobs.example.org
bun scripts/dev.ts up
bun scripts/build-workspace.ts
```

Replace these example domains with your configured proxies. The relay proxy must support WebSocket upgrades. Route the Blossom origin to the loopback port in `development-published/origin.json`; retain its CORS and range behavior. These variables advertise addresses, not provision DNS, TLS, proxies or hosting.

Use secure endpoints for an HTTPS website. Embedded Paja previews and their expiring local links remain development-local; a reachable published naddr and blobs let other compatible shells test the applet. See the [publication runbook](../runbooks/development-gui#static-hosting-and-publishing).

## Build the documentation at /docs/

```sh
bun install --cwd docs --frozen-lockfile
bun run --cwd docs build
bun run --cwd docs check:links
bun run --cwd docs preview
```

Open the printed preview origin with **`/docs/`** appended. The output is `docs/.vitepress/dist/`. Deploy its contents into the `docs/` directory of your static site's document root, not into the document root itself. Keep the configured VitePress base `/docs/`.

For example, with `/srv/applet-site` as the document root:

```text
/srv/applet-site/
  index.html          # workspace, if hosted here
  cvm.json
  docs/
    index.html
    users/
    operators/
    implementers/
    developers/
    assets/
    contracts/
```

Clean documentation URLs require your host to resolve `/docs/users/quick-start` to `/docs/users/quick-start.html`, and directory routes to their `index.html`. An Nginx location can use:

```nginx
location /docs/ {
    root /srv/applet-site;
    try_files $uri $uri.html $uri/index.html =404;
}
```

This serves actual built pages; do not rewrite every missing docs URL to the workspace homepage. Hashed assets can be cached long-term; HTML and the schema catalog should revalidate. VitePress explains [base paths and static deployment](https://vitepress.dev/guide/deploy).

The documentation CI uploads a static artifact with the `docs/` directory already included. A GitHub project Pages URL under `/cvm/` does not match `/docs/`; use a domain/root deployment that can mount `/docs/`, or explicitly change the requirement and base together. No public deployment is provisioned by the documentation build.
