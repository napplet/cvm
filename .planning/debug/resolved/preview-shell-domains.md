---
status: resolved
trigger: "CVM preview does not inject required outbox; use a proper Paja/Kehto host with broad domain support."
created: 2026-11-09
updated: 2026-11-09
---

# Preview host domains

The preview explicitly disabled every Paja domain, relay access, ACL and firewall access. It also hid Paja's host controls. This caused missing OUTBOX injection regardless of whether the applet's query was valid. Relay reachability is a separate query-result condition.

The fix uses the pinned Paja 0.19.0 concrete host composition and its browser availability and consent gates. Its controls remain reachable; the drawer starts compact only when no saved preference exists. No replacement runtime or mock OUTBOX was added.

The proxy substitutes an owner/artifact-bound window identity and the sealed aggregate hash instead of Paja's shared development defaults. Generic targets are scoped by their exact URL. The existing fixed route allowlist, grant authorization, byte verification and opaque applet sandbox remain in effect.

A related browser regression refreshed a failed revision's status by replacing its verified preview URL. Failure refresh now updates status and repair availability without reloading the live iframe or discarding its in-memory state. The browser journey accounts for the separately metered automatic correction.

## Verification

- Chromium and public proxy: 2 tests / 29 assertions, on workstation and Linux. A local WebSocket relay returns a signed kind-1 note for a 24-hour query with timeoutMs; the exact note reaches result.events[].event. A separate kind-7 request returns an ordinary empty result. Public relay availability is not a CI dependency.
- Real PostgreSQL, grants and asset boundaries: 2 tests / 43 assertions, including tampered bytes, invalid grants, traversal and denied direct browser egress.
- Full product browser journey with fixture OAuth/model and real Cashu, relay, PostgreSQL, Docker worker and Paja: passed. Host controls are reachable, toggling preserves applet state, failed revisions retain the live preview and draft, and inference/charge counts remain exact.
- Pinned TypeScript 5.9.3: passed.
- Contract catalog, documentation build and 1,838 local links: passed.

Reference implementations: Kehto/Paja's pinned package README and applesauce's napplet loader/outbox examples. Deployment records and live operational details stay in the operator repository.
