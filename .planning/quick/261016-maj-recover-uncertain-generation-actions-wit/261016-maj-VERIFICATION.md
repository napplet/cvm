---
status: passed
---

- Gateway/model/revision tests: 49 passed, 254 assertions. Includes >2 MB valid streaming traffic, retained-item/traffic bounds, terminal validation and no redispatch.
- Real SQL interrupted-generation test: owner isolation, concurrent exact-once release, original observation/fence retained, replay without inference, live and crash claims retained, saved source retained, zero local charge.
- Browser timeout regression: clear timeout, OAuth retained, redaction, restart replay fence.
- Full product workspace: fixture OAuth/model, real relay/Cashu/Postgres/Docker/Paja; six explicit inferences, five charged completions, one waived interruption, next revision verified as version 4. Draft/reload/preview continuity and no duplicate charge.
- Product view: passed; updated unresolved-request copy.
- Static assets built in composed tests and the live service serves the updated bundle.
- Typecheck: same 424 pre-existing diagnostics, no new normalized diagnostics.
- git diff --check passed.
- Live version-5 recovery: no inference, no version advancement, zero local charge. Restart occurred only after active action count was zero.

Logs: /tmp/cvm-recovery-{unit,sql,timeout,product,view,typecheck}.log.
