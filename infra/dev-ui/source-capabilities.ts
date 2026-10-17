/** Data-only authoring surface; never evaluate generated configuration. */
export const CAPABILITIES_PATH = "src/capabilities.json";
export type SourceCapabilities = { required: string[]; optional: string[] };
export function sourceCapabilities(files: readonly { path: string; content: string }[]): SourceCapabilities | undefined {
  const entries = files.filter(file => file.path === CAPABILITIES_PATH);
  if (!entries.length) return undefined; // Historical proposals predate declarations.
  if (entries.length !== 1 || entries[0]!.content.length > 4096) throw new Error("SOURCE_CAPABILITIES_INVALID");
  const value = JSON.parse(entries[0]!.content);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "optional,required") throw new Error("SOURCE_CAPABILITIES_INVALID");
  for (const domains of [value.required, value.optional]) {
    if (!Array.isArray(domains) || domains.length > 32 || domains.some(domain => typeof domain !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(domain))) throw new Error("SOURCE_CAPABILITIES_INVALID");
  }
  const optional = [...new Set<string>(value.optional)].sort();
  return { required: [...new Set<string>(value.required)].filter(domain => !optional.includes(domain)).sort(), optional };
}
