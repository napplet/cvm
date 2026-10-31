import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { inspectDirectPreviewDependencyArchive } from "../../scripts/audit-direct-preview-dependencies";

const manifest = JSON.stringify({ name: "@kehto/runtime", version: "0.24.1", license: "MIT", repository: { type: "git", url: "git+https://github.com/kehto/web.git", directory: "packages/runtime" } });
const source = "export const fixture = true;\n";
type File = { path: string; content: string; type?: string };
const files = [{ path: "package/package.json", content: manifest }, { path: "package/dist/index.js", content: source }];
function tar(input: File[]) {
  const records = input.map(file => {
    const data = Buffer.from(file.content), header = Buffer.alloc(512);
    header.write(file.path, 0, 100, "utf8"); header.write(data.length.toString(8).padStart(11, "0"), 124, 11, "ascii");
    header.fill(32, 148, 156); header.write(file.type ?? "0", 156, 1, "ascii"); header.write("ustar", 257, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii"); header[154] = 0; header[155] = 32;
    const body = Buffer.alloc(Math.ceil(data.length / 512) * 512); data.copy(body);
    return Buffer.concat([header, body]);
  });
  return Buffer.concat([...records, Buffer.alloc(1024)]);
}
async function fixture(run: (root: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "cvm-preview-audit-")), root = join(directory, "package");
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "package.json"), manifest); await writeFile(join(root, "dist/index.js"), source);
    await run(root, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("package review compares every installed file without executing or modifying it", async () => {
  await fixture(async root => {
    const result = await inspectDirectPreviewDependencyArchive("@kehto/runtime", gzipSync(tar(files)), root);
    expect(result.fileCount).toBe(2); expect(result.manifest.name).toBe("@kehto/runtime"); expect(result.installedTreeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readFile(join(root, "dist/index.js"), "utf8")).toBe(source);
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(manifest);
    await writeFile(join(root, "extra.js"), "must not be silently omitted");
    await expect(inspectDirectPreviewDependencyArchive("@kehto/runtime", gzipSync(tar(files)), root)).rejects.toThrow("UNEXPECTED_INSTALLED_FILE");
  });
});

test("package review refuses changed installed bytes and links outside the package", async () => {
  await fixture(async (root, directory) => {
    await writeFile(join(root, "dist/index.js"), "x".repeat(Buffer.byteLength(source)));
    await expect(inspectDirectPreviewDependencyArchive("@kehto/runtime", gzipSync(tar(files)), root)).rejects.toThrow("INSTALLED_DRIFT");
    await rm(join(root, "dist/index.js")); await writeFile(join(directory, "outside.js"), source);
    await symlink(join(directory, "outside.js"), join(root, "dist/index.js"));
    await expect(inspectDirectPreviewDependencyArchive("@kehto/runtime", gzipSync(tar(files)), root)).rejects.toThrow("INSTALLED_DRIFT");
  });
});

test("package review rejects traversal, archive links, duplicates, checksum corruption and absent manifest", async () => {
  await fixture(async root => {
    for (const invalid of [
      [{ path: "package/../escape", content: source }],
      [{ path: "package/dist/index.js", content: source, type: "2" }],
      [...files, files[0]!],
      [files[1]!],
    ]) await expect(inspectDirectPreviewDependencyArchive("@kehto/runtime", gzipSync(tar(invalid)), root)).rejects.toThrow();
    const corrupt = tar(files); corrupt[0] = 0;
    await expect(inspectDirectPreviewDependencyArchive("@kehto/runtime", gzipSync(corrupt), root)).rejects.toThrow("TAR_INVALID");
    await expect(inspectDirectPreviewDependencyArchive("@kehto/runtime", gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1)), root)).rejects.toThrow();
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(manifest);
  });
});
