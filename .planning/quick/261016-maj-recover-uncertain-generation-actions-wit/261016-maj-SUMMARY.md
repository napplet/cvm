---
status: complete
---

# Interrupted development generation recovery

Fixed the actual CHATGPT_RESPONSE_TOO_LARGE failure: the old 2 MB cumulative SSE limit counted repeated delta envelopes. Streaming traffic is now bounded separately (32 MB total, 2 MB per event/retained completed items), retaining the five-minute deadline, terminal completion/usage requirements and 128 KB source bound.

Development-only recovery closes a durably ended ChatGPT subscription request with no saved source/receipt as MODEL_RESPONSE_INTERRUPTED. The operator waives the synthetic local charge; provider usage remains explicitly unknown. The original ChatGPT observation and provider dispatch fence remain immutable. The existing serializable settlement releases the action reservation exactly once and preserves the last verified version. Recovery happens on request completion and authenticated session access. Live/unfinished claims, retained source and non-subscription pricing are excluded.

The client preserves drafts and enables the next explicit revision, with actionable text and no automatic inference. Added real SQL coverage and updated the composed browser regression to prove an interrupted revision can be followed by a successful revision.

Default service restarted while idle at http://127.0.0.1:49371, PID 92825. Applied the policy only to the user's identified version-5 project (session:c9e45d5b08735e24a782d4d8); resulting state failed, version 5 retained, local charge 0, model calls 0. The other historical uncertain sessions were not mutated.

Remaining active task: 261016-m8c naddr remix and applesauce outbox browsing.
