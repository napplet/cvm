# Provider rejection feedback

Definitive provider non-acceptance previously returned the worker/artifact failure
code despite running no build. It now returns the existing PROVIDER_NOT_ACCEPTED
code. The product explains that the provider needs operator attention instead
of recommending a simpler idea.

Regression proof: seven metering/gateway tests pass, including zero-charge
settlement, no worker invocation and idempotent replay without another provider
dispatch. The Chromium product-view test verifies the displayed provider message.
TypeScript 5.9.3 and diff checks pass. No real model calls, data migration or
credential replacement were performed by this code fix.

Operational investigation separately identified an expired provider credential
and independent service/database identities across deployment origins. These
require operator-side resolution; the presentation change does not restore a
credential or merge user data. Existing terminal receipts remain unchanged.
