# Deferred Items

- **2026-08-03 — TypeScript compiler configuration:** An exploratory `bunx tsc --noEmit` check fails because the existing greenfield `tsconfig.json` does not include Bun/Node type declarations and exposes unrelated pre-existing test typing errors. This plan's required Bun test and candidate workflow checks pass; typecheck configuration belongs to a later tooling-focused plan.
