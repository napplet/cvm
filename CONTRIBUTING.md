# Contributing

Start with the [contributor guide](docs/developers/index.md), [architecture](docs/developers/architecture.md) and [testing instructions](docs/developers/testing.md). Follow the repository's [AGENTS.md](AGENTS.md) when working through an agent.

For a public contract change, use the [Schema amendment issue form](https://github.com/napplet/cvm/issues/new?template=schema-amendment.yml) and [review process](docs/developers/schema-changes.md). Include synthetic before/after examples, authority and billing implications, compatibility/migration and acceptance tests.

Documentation lives in `docs/` and builds as a static VitePress site at `/docs/`:

```sh
bun install --cwd docs --frozen-lockfile
bun run --cwd docs dev
```

See [documentation maintenance](docs/developers/documentation.md) for build/link checks and generated schemas. Never commit private `.local/` state, credentials, OAuth data, payment tokens or browser signer exports.
