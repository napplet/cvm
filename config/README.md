# Certifier configuration

Certification artifacts are created and pinned by the release controller. An
operator must not author a certifier profile, registry module, trust root,
observation, evidence directory, secret-bearing file, or their digest.

For ordinary development, leave the local authority-free configuration in
place. It has no credentials and cannot run protected work. For a protected
release, authenticate the provider clients once, approve the controller-issued
cost/effect digest, and use `bun run release:certify -- --candidate <path>`.
The controller then emits only `NAPPLET_CVM_*` generated configuration names
for the child process; their bytes never need to be copied into an `.env` file.
