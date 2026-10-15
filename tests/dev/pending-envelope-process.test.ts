import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("a saved action decrypts in a fresh process using only its private persisted key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "napplet-pending-process-"));
  const root = resolve(import.meta.dir, "../..");
  const program = `
    import { PendingActionEnvelopeService } from './src/continuity/checkpoint-envelope';
    import { LocalCheckpointStore } from './src/dev/local-checkpoint-store';
    const directory = process.env.PENDING_PROCESS_DIRECTORY;
    const envelope = new PendingActionEnvelopeService(new LocalCheckpointStore({ root: directory + '/keys' }));
    const command = { idempotencyKey: 'process-restart', maximum: '5000', idea: 'A focused counter', policyVersion: 'development-local-v1' };
    if (process.env.PENDING_PROCESS_MODE === 'seal') {
      const value = await envelope.seal({ command, header: { schemaVersion: 'pending-action-envelope-v1', kind: 'pending_action', checkpointId: 'pending-action:process-restart', checkpointVersion: 1, ownerId: 'a'.repeat(64), accountId: 'account:process-restart', commandFingerprint: 'b'.repeat(64), expiresAtMs: Date.now() + 60000, expectedSessionVersion: 0, expectedArtifactVersion: 0, policyVersion: 'development-local-v1', profileId: 'profile', priceCardId: 'card', toolchainId: 'toolchain', rootManifestSha256: 'c'.repeat(64) } });
      await Bun.write(directory + '/envelope.json', JSON.stringify(value));
      console.log('sealed');
    } else {
      const restored = await envelope.open(await Bun.file(directory + '/envelope.json').json());
      if (JSON.stringify(restored.command) !== JSON.stringify(command)) throw new Error('PENDING_PROCESS_COMMAND_MISMATCH');
      console.log('restored');
    }
  `;
  try {
    for (const mode of ["seal", "open"]) {
      const child = Bun.spawn([process.execPath, "-e", program], { cwd: root, env: { ...process.env, PENDING_PROCESS_DIRECTORY: directory, PENDING_PROCESS_MODE: mode }, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout.trim()).toBe(mode === "seal" ? "sealed" : "restored");
    }
    // A replacement key cannot restore the original ciphertext.
    await writeFile(join(directory, "keys/pending-action.key"), crypto.getRandomValues(new Uint8Array(32)), { mode: 0o600 });
    const denied = Bun.spawn([process.execPath, "-e", program], { cwd: root, env: { ...process.env, PENDING_PROCESS_DIRECTORY: directory, PENDING_PROCESS_MODE: "open" }, stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([denied.exited, new Response(denied.stderr).text()]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("PENDING_ACTION_RESTORE_DENIED");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
