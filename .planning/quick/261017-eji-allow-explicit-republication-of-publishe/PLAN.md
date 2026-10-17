---
id: 261017-eji
status: complete
---

Add explicit Republish for an already published version, through the signed CVM protocol. Resend the exact saved event to saved relays, reusing uploaded files and the original signature. Preserve published state even if a later resend cannot confirm; retain a bounded last-attempt result.

1. Add owner-authorized republish command and forced resend mode in the relay worker; ordinary retries retain existing observe-first behavior.
2. Add Republish beside View publication and inside the publication result; show progress and completion without new model calls, blob copies, signing or duplicate publication records.
3. Test actual relay EVENT resend, ownership, UI progress and persistence; responsive checks, screenshot docs/contracts, safe local activation, commit and push main.

Execute gsd-quick inline. User-authorized feature implementation only: no live user republication performed by the agent.
