---
task: 261017-iba
status: complete
---

# Understandable generation pricing

Replaced two unlabeled fraction fields with one explicitly labelled price per 1,000 tokens. Rows explain input/output (and separate cached/reasoning categories when supported), display test-sat units, and show a live example for 10,000 input + 2,000 output tokens. Subscription copy explains that these are local test charges, not changes to ChatGPT prices/usage limits. Price identifiers are collapsed. API evidence-backed prices are read-only here.

Edited decimal prices convert to reduced integer rational rates using BigInt. Untouched rates, including higher-precision values and inactive dimensions, remain exact. Per-category whole-sat rounding matches the ledger. Invalid values disable saving; busy/failed saves retain drafts with inline feedback. No billing schema or CVM protocol changes.

## Verification

- 4 unit/operator tests passed, 52 assertions: exact fractional conversion, small/large values, invalid input, display precision, example rounding and operator authority.
- Actual rate component browser test passed: exact save payload, example updates, unchanged precision, hidden inactive rates, validation, busy/retry handling, API read-only guard and widths 320/375/768/1280px.
- Operator capture script passed all existing job/admin checks and regenerated the pricing illustration. Unchanged job screenshot pixels retained to avoid unrelated churn.
- Docs build and 38-page / 1,329-link checks passed. Provider guide and screenshot metadata updated.
- Targeted live guide checks passed at three widths with nine screenshots decoded at their declared dimensions. Live admin shows existing Input/Output prices of 1, a 12-test-sat example, and disabled Save until edited; no live rates were changed.
- Typecheck remains at 411 pre-existing diagnostics; zero added normalized diagnostics.
- Live CVM refreshed only after verifying no active generation/publication, preserving saved ChatGPT OAuth and existing rates. Admin http://127.0.0.1:49371/admin; guide http://127.0.0.1:4173/docs/operators/providers.
- Full publication journey selector updated for the new labelled price; the unchanged publication flow was not rerun for this presentation change.
