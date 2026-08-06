# Certifier configuration

Local development uses `certifier.local.json`. It has no credentials, adapter,
trust root, release profile, or protected evidence authority. `bun test` also
defaults to this authority-free mode when no environment file is present.

Production certification uses one operator-owned JSON file selected by:

```text
NAPPLET_CVM_CERTIFIER_CONFIG=/absolute/path/to/certifier.json
NAPPLET_CVM_CERTIFIER_CONFIG_SHA256=<sha256-of-exact-config-bytes>
```

The protected file has this shape:

```json
{
  "version": 1,
  "mode": "protected",
  "releaseProfilePath": "/protected/release.json",
  "evidenceDirectory": "/protected/evidence",
  "credentials": "configured",
  "adapter": {
    "root": "/protected/certifier",
    "modulePath": "/protected/certifier/adapter.js",
    "sha256": "<64 lowercase hex characters>"
  },
  "trustRoot": {
    "root": "/protected/certifier",
    "modulePath": "/protected/certifier/trust-root.js",
    "sha256": "<64 lowercase hex characters>"
  }
}
```

Optional `reproducibility` and `supplyChain` sections provide their input and
output paths. Those values describe real release evidence and therefore belong
in protected deployment configuration, not in a developer `.env`.
