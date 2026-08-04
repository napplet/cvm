# Deferred Items

- `bunx tsc --noEmit` is not an executable project gate yet: the repository does not pin TypeScript or Bun/Node type declarations, and the command reports existing Phase 1 typing/configuration failures. Phase 02's runnable Bun test suite remains green; establish a locked type-check configuration in a scoped future task before treating `tsc` as required verification.
