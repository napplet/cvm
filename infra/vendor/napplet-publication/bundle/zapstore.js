// @bun
// infra/vendor/napplet-publication/client-tag.ts
function withClientTag(tags) {
  return [...tags.filter((tag) => tag[0] !== "client"), ["client", "napplet.run"]];
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
function linkZapstoreApplication(manifests, application, relays) {
  const identifiers = application.tags.filter((tag) => tag[0] === "d");
  if (application.kind !== 32267 || identifiers.length !== 1 || !identifiers[0][1]) {
    throw new Error("Application reference requires kind 32267 with one non-empty d tag");
  }
  const reference = ["app", `32267:${application.pubkey}:${identifiers[0][1]}`];
  const relay = relays.find((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "wss:" || url.protocol === "ws:";
    } catch {
      return false;
    }
  });
  if (relay)
    reference.push(relay);
  return manifests.map((manifest) => {
    if (manifest.format !== "current" || !manifest.template)
      return manifest;
    if (manifest.signedEvent)
      throw new Error("Application references must be attached before manifest signing");
    return {
      ...manifest,
      template: {
        ...manifest.template,
        tags: [...manifest.template.tags.filter((tag) => tag[0] !== "app"), [...reference]]
      }
    };
  });
}
export {
  prepareZapstorePublication,
  normalizeZapstoreConfig,
  linkZapstoreApplication
};
