import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The hosted PG17 fixture exercises an official SDK client against a local,
// disposable TLS relay. Keep verification enabled by giving only its child
// process the generated CA; no test disables certificate checking.
const directory = await mkdtemp(join(tmpdir(), "cvm-durability-tls-"));
const cert = join(directory, "cert.pem"), key = join(directory, "key.pem");
try {
  const openssl = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert], { stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => openssl.kill(), 15_000);
  try {
    const error = await new Response(openssl.stderr).text();
    if (await openssl.exited !== 0) throw new Error(`DURABILITY_TEST_CA_FAILED:${error.slice(-200)}`);
  } finally { clearTimeout(timer); }
  const child = Bun.spawn(["bun", "test", "tests/production/durability-registry.test.ts", "tests/production/durability-registry-postgres.test.ts", "tests/production/retained-subjects-postgres.test.ts", "tests/production/resume-pricing-preparer-postgres.test.ts", "tests/production/checkpoint-postgres.test.ts", "tests/production/postgres-bytea-object-store-postgres.test.ts", "tests/production/object-retention-postgres.test.ts", "--timeout", "120000"], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: cert, NAPPLET_DURABILITY_TEST_TLS_CERT: cert, NAPPLET_DURABILITY_TEST_TLS_KEY: key, NAPPLET_CVM_TEST_EXTERNAL_EFFECTS: "deny" },
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const childTimer = setTimeout(() => child.kill(), 150_000);
  try { process.exitCode = await child.exited; } finally { clearTimeout(childTimer); }
} finally { await rm(directory, { recursive: true, force: true }); }
