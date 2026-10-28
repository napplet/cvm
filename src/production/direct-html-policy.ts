import { ident, parse, walk } from "css-tree";

const failure = (): never => { throw new Error("PRODUCTION_DIRECT_HTML_POLICY_REJECTED"); };
const inlineUrl = (value: string) => /^(?:data:|blob:|#)/iu.test(value.trim());

function verifyCss(source: string, context: "stylesheet" | "declarationList"): void {
  try {
    const ast = parse(source, { context, parseCustomProperty: true });
    walk(ast, function (node) {
      if (node.type === "Raw") failure(); // Unparsed syntax cannot prove containment.
      if (node.type === "Atrule" && ident.decode(node.name).toLowerCase() === "import") failure();
      if (node.type === "Declaration" && ["behavior", "-moz-binding"].includes(ident.decode(node.property).toLowerCase())) failure();
      if (node.type === "Url") {
        // Namespace identifiers do not fetch resources.
        const namespace = this.atrule && ident.decode(this.atrule.name).toLowerCase() === "namespace" && this.atrule.block === null;
        if (!namespace && !inlineUrl(node.value)) failure();
      }
      if (node.type === "Function" && ident.decode(node.name).toLowerCase() === "expression") failure();
      if (node.type === "String" && this.function && ["url", "image", "image-set", "-webkit-image-set", "src"].includes(ident.decode(this.function.name).toLowerCase()) && !inlineUrl(node.value)) failure();
    });
  } catch { failure(); }
}

/** Direct artifacts have one deployable file. Validate their actual parsed HTML
 * and CSS without resolving or fetching any referenced resource. */
export async function verifyDirectArtifactHtml(html: string): Promise<void> {
  if (!/^\s*<!doctype html>/iu.test(html)) throw new Error("PRODUCTION_ARTIFACT_HTML_DOCTYPE_REQUIRED");
  let denied = false, activeStyle: number | undefined;
  const styles: string[] = [];
  const svgCssAttributes = new Set(["fill", "stroke", "filter", "clip-path", "mask", "cursor", "marker", "marker-start", "marker-mid", "marker-end", "color-profile"]);
  const resourceAttributes = new Set(["src", "href", "srcset", "action", "formaction", "poster", "background", "data", "xlink:href", "ping", "manifest", "dynsrc", "lowsrc"]);
  const parser = new HTMLRewriter().on("*", { element(element) {
    const tag = element.tagName.toLowerCase();
    if (["base", "iframe", "frame", "object", "embed"].includes(tag) || tag === "meta" && element.getAttribute("http-equiv")?.toLowerCase() === "refresh") denied = true;
    for (const [name, value] of element.attributes) {
      const attribute = name.toLowerCase();
      if (attribute === "style") verifyCss(value, "declarationList");
      if (svgCssAttributes.has(attribute)) verifyCss(`${attribute}:${value}`, "declarationList");
      if (!resourceAttributes.has(attribute)) continue;
      const fragment = ["a", "use"].includes(tag) && ["href", "xlink:href"].includes(attribute) && value.startsWith("#");
      const media = ["img", "image", "audio", "video", "source"].includes(tag) && ["src", "href", "xlink:href", "poster"].includes(attribute) && /^(?:data:(?:image|audio|video)\/|blob:)/iu.test(value);
      const icon = tag === "link" && element.getAttribute("rel")?.toLowerCase() === "icon" && attribute === "href" && /^data:image\//iu.test(value);
      if (!fragment && !media && !icon) denied = true;
    }
  } }).on("style", {
    element(element) {
      if (activeStyle !== undefined) denied = true;
      activeStyle = styles.push("") - 1;
      element.onEndTag(() => { activeStyle = undefined; });
    },
    text(chunk) { if (activeStyle !== undefined) styles[activeStyle] += chunk.text; },
  });
  await parser.transform(new Response(html)).text();
  if (denied) failure();
  for (const css of styles) verifyCss(css, "stylesheet");
}
