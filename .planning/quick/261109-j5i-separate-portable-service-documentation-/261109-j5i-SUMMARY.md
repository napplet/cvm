# Portable deployment boundary

Application documentation now describes the public container/configuration interface, with a schema-validated example. Inventories, automation and environment records belong to an operator-owned repository. Machine-specific runtime manifests, gateway scripts and the live smoke test were moved out; private deployment tooling assembles its own overlay without changing application source. PR metadata describes portable behavior and launch limitations.

No deployment or history rewrite is part of this correction. Previously published history is not erased by removing files from the current tree.

Validation: configuration example parses through the actual service schema; documentation builds (62 pages, 1,837 local links/assets/fragments checked); contract catalog and three MCP compatibility tests pass. Operator overlay test and five existing deployment tests pass locally using temporary repositories; no live deployment was performed. Historical planning Markdown was normalized for personal workstation paths and deployment identifiers, with originals preserved in operator records.
