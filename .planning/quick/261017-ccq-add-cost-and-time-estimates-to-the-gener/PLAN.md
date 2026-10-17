---
id: 261017-ccq
status: complete
description: Add cost and time estimates to the generation GUI
---

Implement inline through gsd-quick. User requested GUI estimations; user explicitly confirmed both cost and time.

1. Extend signed CVM service information with coarse historical ranges for the verified caller's completed builds at the current provider/rates. Separate creation/revision when history permits, label fallback history, and return unavailable when no valid data exists. No credentials, project records, model calls, or new HTTP API.
2. Show estimated cost/time before creation and revision, maximum separately, and an approximate remaining duration during active work. Handle stale updates, overruns, recovery, and actual confirmed charges honestly. Preserve responsive application layout and real stage progress.
3. Verify aggregation, identity isolation and no-history behavior; browser timing and responsive states; real CVM integration. Update illustrated user docs and generated contract catalog. Activate the idle local development service, preserve operator configuration, record checks, commit and push main.

Estimates are guidance from recent successful runs, not quotes or deadlines. Development costs remain test sats and do not estimate ChatGPT subscription allowance.
