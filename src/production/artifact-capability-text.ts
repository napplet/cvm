/** Inert HTML labels do not exercise shell capabilities. Preserve script and
 * event-handler text (including split parser chunks); non-HTML output retains
 * the existing conservative scan over every byte. Network/code denials remain
 * the caller's separate scan over the entire original artifact. */
export async function artifactCapabilityText(path: string, text: string): Promise<string> {
  if (!/\.html?$/iu.test(path)) return text;
  const chunks: string[] = [];
  const parser = new HTMLRewriter().on("script", {
    element(element) { chunks.push("\n"); element.onEndTag(() => { chunks.push("\n"); }); },
    text(part) { chunks.push(part.text); },
  }).on("*", { element(element) {
    for (const [name, value] of element.attributes) if (/^on/iu.test(name)) chunks.push(`\n${value}\n`);
  } });
  await parser.transform(new Response(text)).text();
  return chunks.join("");
}
