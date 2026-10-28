import { describe, expect, test } from "bun:test";
import { verifyDirectArtifactHtml } from "../../src/production/direct-html-policy";

describe("single-file direct HTML containment", () => {
  for (const body of [
    "<style>@namespace svg url(http://www.w3.org/2000/svg); main{color:red}</style>",
    "<style>main{background:url(data:image/png;base64,YQ==);--icon:url(#symbol)}</style>",
    '<style>main{background:image-set("data:image/png;base64,YQ==" 1x)}</style>',
    '<main style="color:red"><a href="#section">jump</a><svg><use href="#symbol"/></svg></main>',
    '<svg><rect fill="url(#gradient)" filter="url(#shadow)"/></svg>',
    '<script type="module">document.body.dataset.ready = "yes";</script><img src="data:image/png;base64,YQ==">',
  ]) test(`accepts inline content: ${body.slice(0, 70)}`, async () => {
    await expect(verifyDirectArtifactHtml(`<!doctype html>${body}`)).resolves.toBeUndefined();
  });
  for (const body of [
    '<script src="assets/app.js"></script>', '<link rel="stylesheet" href="/app.css">',
    '<link rel="stylesheet" href="#sheet">', '<image href="#image"/>',
    '<img src="https://remote.invalid/image">', '<a href="#section" ping="https://remote.invalid">x</a>',
    '<img srcset="data:image/png;base64,YQ== 1x, https://remote.invalid/i 2x">',
    '<base href="https://remote.invalid"><iframe srcdoc="hi"></iframe>',
    '<meta http-equiv="refresh" content="0;url=https://remote.invalid">',
    '<style>main{background:url(./image.png)}</style>',
    '<style>main{background:u\\72l(https://remote.invalid/image)}</style>',
    '<style>@\\69mport "https://remote.invalid/style";</style>',
    '<style>main{background:image-set("https://remote.invalid/image" 1x)}</style>',
    '<style>main{background:-webkit-image-set("./image.png" 1x)}</style>',
    '<style>main{--image:url(https://remote.invalid/image)}</style>',
    '<main style="background:url(https://remote.invalid/image)"></main>',
    '<svg><rect fill="url(https://remote.invalid/gradient)"/></svg>',
    '<svg><rect filter="url(./filters.svg#shadow)"/></svg>',
    '<style>main{behavior:url(#default)}</style>',
    '<style>main{width:expression(alert(1))}</style>',
    '<style>main{color:???}</style>',
  ]) test(`rejects unresolved or external resources: ${body.slice(0, 70)}`, async () => {
    await expect(verifyDirectArtifactHtml(`<!doctype html>${body}`)).rejects.toThrow("PRODUCTION_DIRECT_HTML_POLICY_REJECTED");
  });
  test("requires a doctype", async () => {
    await expect(verifyDirectArtifactHtml("<html></html>")).rejects.toThrow("DOCTYPE_REQUIRED");
  });
});
