// @bun
// infra/vendor/napplet-cli/types.ts
var NAPPLET_KIND_ROOT = 15129;
var NAPPLET_KIND_NAMED = 35129;

// infra/vendor/napplet-cli/manifest.ts
var NAMED_SITE_D_TAG_PATTERN = /^[a-z0-9-]+$/;
async function computeAggregateHash(files) {
  if (files.length === 0)
    throw new Error("Manifest must include at least one path tag");
  const lines = files.map((file) => {
    assertManifestFile(file);
    return `${file.sha256} ${file.path}
`;
  }).sort();
  return await sha256Text(lines.join(""));
}
async function createSiteManifestTemplate(item, files, options = {}) {
  if (item.target === "snapshot") {
    throw new Error("Use createSnapshotManifestTemplate for snapshot manifests");
  }
  const aggregateHash = await computeAggregateHash(files);
  const tags = [];
  if (item.target === "named")
    tags.push(["d", normalizeDTag(item.dTag)]);
  for (const file of files)
    tags.push(["path", file.path, file.sha256]);
  tags.push(["x", aggregateHash, "aggregate"]);
  for (const server of options.servers ?? [])
    tags.push(["server", server]);
  for (const tag of options.metadataTags ?? [])
    tags.push([...tag]);
  return {
    kind: item.target === "root" ? NAPPLET_KIND_ROOT : NAPPLET_KIND_NAMED,
    created_at: options.createdAt ?? nowSeconds(),
    tags,
    content: ""
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
async function sha256Text(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hex(new Uint8Array(digest));
}
function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function assertManifestFile(file) {
  if (!file.path.startsWith("/") || file.path.endsWith("/")) {
    throw new Error(`Manifest path must be an absolute file path: ${file.path}`);
  }
  if (!/^[0-9a-f]{64}$/.test(file.sha256)) {
    throw new Error(`Manifest sha256 must be lowercase hex: ${file.path}`);
  }
}
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// infra/vendor/napplet-cli/deploy-network.ts
import { SimplePool } from "nostr-tools/pool";

// infra/vendor/napplet-cli/blossom-upload.ts
import { base64urlnopad } from "@scure/base";
var UPLOAD_AUTH_KIND = 24242;
var UPLOAD_AUTH_TTL_SECONDS = 3600;
async function createUploadAuthorization(signer, blobSha256s, now = () => Math.floor(Date.now() / 1000), server, encoding = "base64url") {
  const createdAt = now();
  const tags = [
    ["t", "upload"],
    ...blobSha256s.map((hash) => ["x", hash]),
    ["expiration", String(createdAt + UPLOAD_AUTH_TTL_SECONDS)],
    ["client", "napplet"]
  ];
  if (server)
    tags.push(["server", server]);
  const signed = await signer.sign({
    kind: UPLOAD_AUTH_KIND,
    created_at: createdAt,
    tags,
    content: "Upload blobs via napplet"
  });
  return `Nostr ${encodeAuthEvent(signed, encoding)}`;
}
function encodeAuthEvent(event, encoding) {
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  if (encoding === "base64url")
    return base64urlnopad.encode(bytes);
  let binary = "";
  for (const byte of bytes)
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

// infra/vendor/napplet-cli/deploy-network.ts
async function publishEventWithSimplePool(relays, event) {
  const pool = new SimplePool;
  try {
    const settled = await Promise.allSettled(pool.publish(relays, event, { maxWait: 15000 }));
    return relays.map((relay, index) => {
      const result = settled[index];
      if (result?.status === "fulfilled") {
        return { relay, eventId: event.id, success: true };
      }
      const reason = result?.status === "rejected" ? result.reason : "publish did not run";
      return {
        relay,
        eventId: event.id,
        success: false,
        error: reason instanceof Error ? reason.message : String(reason)
      };
    });
  } finally {
    pool.close(relays);
    pool.destroy();
  }
}

// infra/vendor/napplet-cli/entry.ts
var createSiteManifestTemplate2 = createSiteManifestTemplate;
var computeAggregateHash2 = computeAggregateHash;
var publishEventWithSimplePool2 = publishEventWithSimplePool;
var createUploadAuthorization2 = createUploadAuthorization;
export {
  publishEventWithSimplePool2 as publishEventWithSimplePool,
  createUploadAuthorization2 as createUploadAuthorization,
  createSiteManifestTemplate2 as createSiteManifestTemplate,
  computeAggregateHash2 as computeAggregateHash
};
