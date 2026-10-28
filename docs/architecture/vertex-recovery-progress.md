# Durable original-interaction scan progress

Tracked in [issue63](https://github.com/napplet/cvm/issues/63).

A lost Vertex creation acknowledgement leaves an owned request without a native
resource ID. The old reader always restarted the first listing and stopped at
32 resource reads. An original at index40 of65 was never queried, even after
three fresh controllers. Repeating those reads did not recover the paid result.

## Authority and bounded progress

The actual PostgreSQL Vertex journal adapter now supplies a scan companion bound
to the original operation and request hash. Every load/CAS verifies the original
immutable journal identity. The companion uses the existing restricted production
SQL journal, not another authority or a generation request queue. It contains
one metadata batch (at most500 IDs), its index, an opaque next-page token, three
recent token hashes, and match/uncertainty flags. It contains no generated output,
new prices or credentials.

Each observation window retains the existing limits:32 native resource GETs,
three list pages, and the25-second guard before starting another observation.
The existing HTTP timeout separately bounds an in-flight request; simulated
clock tests do not prove an actual elapsed25-second call limit. A final original
GET fits inside the same resource-read budget. There is no total-page cap that
restarts every valid long listing at page one.

Exact stored input establishes a match; native response IDs must equal the IDs
requested. Unrelated resources are skipped. Distinct matching resources retain
sticky ambiguity; repeated metadata for the same ID is one resource. A complete
pass with unproven resources cannot establish uniqueness. Complete no-match or
unproven passes remain unknown and allow a later fresh observation. Recent token
cycles, malformed pages and expired tokens also remain unknown. Longer invalid
page cycles remain bounded by the window limits and never establish a receipt.
Actual provider ordering and retention still require operational evidence.

CAS rejects stale progress without rewinding a newer controller. A crash before
progress commit may repeat read-only GETs. A lost commit acknowledgement resumes
the committed position. Neither case can authorize another POST. After unique
input and a final original read, the native ID can be retained independently of
incomplete usage. Future controllers use direct GET for that ID. Only complete,
validated usage/output can produce the existing debit-eligible receipt.

## Compatibility and verification

The original strict record, request digest, nonce, immutable prices and normalized
receipt format stay unchanged. Companion keys do not replace original keys. No
SQL migration or public tool-schema change is needed. Legacy test journals that
lack durable cursor support keep bounded query-only behavior; actual production
construction and the owner-checked retained-context router both use the SQL
adapter. Rollback preserves all records; old readers may stall on uncompleted
scans until compatible code returns. They must never reissue the paid request.

Restricted PostgreSQL and the actual HTTP/client/journal test cover an original
beyond32, opaque second pages, empty-page budgets, later visibility, distinct and
repeated IDs, malformed resources/pages, partial usage, token cycles/expiry,
artificial observation-time boundaries, real transaction rollback, lost COMMIT
acknowledgements and concurrent CAS. The original-at40 case uses three fresh
controllers with32/32/2 native reads, one listing and one POST. Existing core
billing/owner/legacy-wire tests remain required. Objects, API responses, clocks
and funds are explicit fixtures, not live provider or release certification.
