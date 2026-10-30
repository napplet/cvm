if (!/^sha256:[a-f0-9]{64}$/u.test(process.env.NAPPLET_CVM_TEST_REAL_WORKER_IMAGE ?? "")) throw new Error("DIRECT_TEST_EXACT_WORKER_IMAGE_REQUIRED");
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Disposable local CA for this test process only. Never disables TLS checking.
const directory = await mkdtemp(join(tmpdir(), "cvm-publication-tls-"));
const cert = join(directory, "cert.pem"), key = join(directory, "key.pem");
try {
  const openssl = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert], { stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => openssl.kill(), 15_000);
  try {
    const error = await new Response(openssl.stderr).text();
    if (await openssl.exited !== 0) throw new Error(`PUBLICATION_TEST_CA_FAILED:${error.slice(-200)}`);
  } finally { clearTimeout(timer); }
  const child = Bun.spawn(["bun", "test", "tests/production/fresh-generation-postgres.test.ts", "tests/production/resume-pricing-preparer-postgres.test.ts", "--timeout", "120000"], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: cert, NAPPLET_PUBLICATION_TEST_TLS_CERT: cert, NAPPLET_PUBLICATION_TEST_TLS_KEY: key, NAPPLET_CVM_TEST_REAL_WORKER_CONTRACT: "nip5d-direct-v1", NAPPLET_RUN_POSTGRES_ISOLATION: "1", NAPPLET_CVM_TEST_EXTERNAL_EFFECTS: "deny" },
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const childTimer = setTimeout(() => child.kill(), 300_000);
  try { process.exitCode = await child.exited; } finally { clearTimeout(childTimer); }
} finally { await rm(directory, { recursive: true, force: true }); }
