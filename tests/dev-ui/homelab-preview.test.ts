import { expect, test } from "bun:test";
import { createPreviewServer } from "../../src/dev-ui/preview-server";

test("homelab preview proxies registered hosts and grant-bound bytes only", async () => {
  const bytes = new TextEncoder().encode("<button>sealed</button>");
  const upstreams: ReturnType<typeof Bun.serve>[] = [];
  const preview = await createPreviewServer({
    publicOrigin: "https://cvm.lab.example",
    repository: { read: async ({ path }: any) => path === "index.html" ? { bytes, file: { path } } : undefined } as any,
    grants: { authorize: async ({ token, path }: any) => token === "allowed" && path === "index.html" ? { artifactId: "artifact" } : undefined } as any,
    paja: { domains: [], async startPajaServer({ options }: any) {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        if (new URL(request.url).pathname === "/__kehto/config.json") return Response.json({ target: { url: options.targetUrl } });
        return new Response('<html><head></head><body><script src="./__kehto/browser-host.js"></script></body></html>', { headers: { "content-type": "text/html" } });
      } }); upstreams.push(server);
      return { url: `http://127.0.0.1:${server.port}`, async close() { server.stop(true); } };
    } },
  });
  try {
    const url = await preview.openPaja("allowed");
    expect(url).toMatch(/^https:\/\/cvm.lab.example\/cvm-preview\/[a-f0-9-]+\/$/);
    const page = await preview.handlePublic(new Request(url + "?presentation=workspace"));
    expect(page?.status).toBe(200); expect(await page!.text()).toContain("data-preview-presentation=\"workspace\"");
    const config = await preview.handlePublic(new Request(url + "__kehto/config.json"));
    expect((await config!.json()).target.url).toBe("https://cvm.lab.example/cvm-artifacts/allowed/index.html");
    const asset = await preview.handlePublic(new Request("https://cvm.lab.example/cvm-artifacts/allowed/index.html"));
    expect(await asset!.text()).toBe("<button>sealed</button>");
    for (const path of [url + "private", url.replace(/[a-f0-9-]{36}/, "00000000-0000-0000-0000-000000000000"), "https://cvm.lab.example/cvm-artifacts/invalid/index.html", "https://cvm.lab.example/cvm-preview/127.0.0.1:22/"]) {
      expect((await preview.handlePublic(new Request(path)))?.status).toBe(404);
    }
    expect(await preview.handlePublic(new Request("https://cvm.lab.example/admin"))).toBeUndefined();
    expect((await preview.handlePublic(new Request(url, { method: "POST" })))?.status).toBe(404);
  } finally { await preview.close(); }
});
