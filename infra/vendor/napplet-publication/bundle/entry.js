// @bun
// infra/vendor/napplet-publication/client-tag.ts
function withClientTag(tags) {
  return [...tags.filter((tag) => tag[0] !== "client"), ["client", "napplet.run"]];
}

// infra/vendor/napplet-publication/html-metadata.ts

// infra/vendor/napplet-publication/manifest-legacy.ts
async function computeAggregateHash(files) {
  if (!files.length)
    throw new Error("Manifest must include at least one path tag");
  const lines = files.map((file) => {
    if (!file.path.startsWith("/") || file.path.endsWith("/") || !/^[0-9a-f]{64}$/.test(file.sha256))
      throw new Error(`Invalid legacy path mapping: ${file.path}`);
    return `${file.sha256} ${file.path}
`;
  }).sort().join("");
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lines)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function buildLegacyManifestFields(files, metadata, description) {
  const roles = [...new Set(metadata.filter((tag) => tag[0] === "z").map((tag) => tag[1]))];
  const intents = metadata.filter((tag) => tag[0] === "i");
  if (intents.length && roles.length !== 1) {
    throw new Error("Legacy output needs explicit metadata.archetypes pairs when z/i advertisements have multiple or no roles");
  }
  const tags = files.map((file) => ["path", file.path, file.sha256]);
  tags.push(["x", await computeAggregateHash(files), "aggregate"]);
  if (description)
    tags.push(["description", description]);
  for (const tag of metadata) {
    if (tag[0] === "R" || tag[0] === "O")
      tags.push(["requires", tag[1]]);
    else if (tag[0] === "z") {
      for (const intent of metadata.filter((item) => item[0] === "i")) {
        tags.push(["archetype", tag[1], intent[1]]);
      }
    } else if (!["i", "description", "path", "x", "d", "a", "A", "server"].includes(tag[0])) {
      tags.push([...tag]);
    }
  }
  return {
    tags: tags.filter((tag, index) => tags.findIndex((other) => JSON.stringify(tag) === JSON.stringify(other)) === index),
    content: ""
  };
}
// infra/vendor/napplet-publication/path.ts
function joinPath(...parts) {
  const joined = parts.filter((part) => part.length > 0).join("/");
  return normalizePath(joined);
}
function normalizePath(path) {
  const absolute = path.startsWith("/");
  const segments = [];
  for (const raw of path.replaceAll("\\", "/").split("/")) {
    if (raw === "" || raw === ".")
      continue;
    if (raw === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push(raw);
      }
      continue;
    }
    segments.push(raw);
  }
  const result = segments.join("/");
  if (absolute)
    return `/${result}`;
  return result || ".";
}
function isAbsolute(path) {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
}
function resolvePath(base, path) {
  if (isAbsolute(path))
    return normalizePath(path);
  return normalizePath(joinPath(base, path));
}

// infra/vendor/napplet-publication/types.ts
var NAPPLET_KIND_ROOT = 15129;
var NAPPLET_KIND_NAMED = 35129;

// infra/vendor/napplet-publication/manifest.ts
var NAMED_SITE_D_TAG_PATTERN = /^[a-z0-9-]+$/;
async function createSiteManifestTemplate(item, files, options = {}) {
  if (item.target === "snapshot") {
    throw new Error("Use createSnapshotManifestTemplate for snapshot manifests");
  }
  const format = options.format ?? "current";
  const metadataTags = options.metadataTags ?? [];
  const content = options.content ?? metadataTags.find((tag) => tag[0] === "description")?.[1] ?? "";
  const fields = format === "legacy" ? await buildLegacyManifestFields(files, metadataTags, content) : buildCurrentManifestFields(files, metadataTags, content);
  const tags = [];
  if (item.target === "named")
    tags.push(["d", normalizeDTag(item.dTag)]);
  tags.push(...fields.tags);
  for (const server of options.servers ?? metadataTags.filter((t) => t[0] === "server").map((t) => t[1]))
    tags.push(["server", server]);
  return {
    kind: item.target === "root" ? NAPPLET_KIND_ROOT : NAPPLET_KIND_NAMED,
    created_at: options.createdAt ?? nowSeconds(),
    tags: withClientTag(tags),
    content: fields.content
  };
}
function normalizeDTag(value) {
  const dTag = value?.trim() ?? "";
  if (!NAMED_SITE_D_TAG_PATTERN.test(dTag) || dTag.endsWith("-")) {
    throw new Error("Named napplet d tag must match ^[a-z0-9-]+$ and not end with '-'");
  }
  return dTag;
}
var DEPLOY_IGNORED_DIRECTORY_NAMES = new Set(["node_modules"]);
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}
function buildCurrentManifestFields(files, metadata, content) {
  const index = files.filter((file) => file.path === "/index.html");
  if (index.length !== 1 || !/^[0-9a-f]{64}$/.test(index[0].sha256)) {
    throw new Error("NIP-5D requires one /index.html artifact hash");
  }
  if (!content.trim()) {
    throw new Error("Set metadata.description in .napplet/config.yaml or an HTML description meta before deploying current NIP-5D events");
  }
  for (const tag of metadata.filter((tag2) => tag2[0] === "R" || tag2[0] === "O")) {
    if (tag.length !== 2 || !tag[1] || /[:\s]/.test(tag[1]) || tag[1].startsWith("NAP-")) {
      throw new Error("Capability tags must name one bare NAP domain");
    }
  }
  for (const tag of metadata.filter((tag2) => tag2[0] === "i")) {
    if (!tag[1]?.trim() || tag[1].includes("?")) {
      throw new Error("Intent advertisements must be non-empty queryless identities");
    }
  }
  return {
    tags: [
      ["x", index[0].sha256],
      ...metadata.filter((tag) => !["description", "x", "path", "d", "a", "A", "server"].includes(tag[0])).map((tag) => [...tag])
    ],
    content
  };
}
// infra/vendor/napplet-publication/zapstore.ts
function normalizeZapstoreConfig(input) {
  if (input === undefined)
    return;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("zapstore must be an object");
  }
  const value = input;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error("zapstore.enabled must be a boolean");
  }
  const result = { enabled: value.enabled };
  for (const key of [
    "id",
    "name",
    "description",
    "summary",
    "icon",
    "website",
    "repository",
    "license"
  ]) {
    const field = value[key];
    if (field === undefined && key !== "id" && key !== "name")
      continue;
    if (typeof field !== "string" || !field.trim()) {
      throw new Error(`zapstore.${key} must be a non-empty string`);
    }
    result[key] = field.trim();
  }
  for (const key of ["images", "tags"]) {
    const field = value[key];
    if (field === undefined)
      continue;
    if (!Array.isArray(field) || field.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`zapstore.${key} must contain non-empty strings`);
    }
    result[key] = [...new Set(field.map((item) => item.trim()))];
  }
  return result;
}
async function prepareZapstorePublication(config, servers, options = {}) {
  if (!(options.enabled ?? config.zapstore?.enabled ?? false))
    return;
  const metadata = normalizeZapstoreConfig(config.zapstore);
  if (!metadata)
    throw new Error("--zapstore requires zapstore.id and zapstore.name in config");
  const files = [];
  const cwd = options.cwd ?? Deno.cwd();
  const media = async (value) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
      const url = new URL(value);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("Zapstore image URLs must use HTTP(S) without credentials");
      }
      return url.href;
    }
    if (!servers.length)
      throw new Error("Local Zapstore images require a Blossom server");
    const path = resolvePath(cwd, value);
    const data = await Deno.readFile(path);
    const contentType = imageType(data);
    if (!contentType)
      throw new Error(`Zapstore image must be PNG, JPEG, or WebP: ${value}`);
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (!files.some((file) => file.sha256 === sha256)) {
      files.push({ candidateDir: cwd, path: value, sha256, data, contentType });
    }
    return `${servers[0].replace(/\/$/, "")}/${sha256}`;
  };
  const tags = [["d", metadata.id], ["name", metadata.name]];
  for (const [key, tag] of [["summary", "summary"], ["website", "url"], ["repository", "repository"], [
    "license",
    "license"
  ]]) {
    if (metadata[key])
      tags.push([tag, metadata[key]]);
  }
  if (metadata.icon)
    tags.push(["icon", await media(metadata.icon)]);
  for (const value of metadata.images ?? [])
    tags.push(["image", await media(value)]);
  for (const topic of metadata.tags ?? [])
    tags.push(["t", topic]);
  return {
    template: {
      kind: 32267,
      created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
      content: metadata.description ?? config.metadata?.description ?? "",
      tags: withClientTag(tags)
    },
    files,
    mediaServer: files.length ? servers[0] : undefined
  };
}
function imageType(bytes) {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) {
    return "image/png";
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  const text = new TextDecoder().decode(bytes.subarray(0, 12));
  if (text.startsWith("RIFF") && text.endsWith("WEBP"))
    return "image/webp";
  return;
}
export {
  prepareZapstorePublication,
  createSiteManifestTemplate
};
