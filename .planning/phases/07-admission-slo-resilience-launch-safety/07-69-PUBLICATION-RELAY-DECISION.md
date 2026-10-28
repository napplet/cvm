# Deferred publication relay composition

The mounted runtime must not require a future signed owner event in its
preapproval provider configuration. Resolve the verified source context first;
accept only the externally signed, unchanged pinned CLI template; then persist
the actual owner event and service attestation under the approved request and
original intent. Use the existing pinned CLI relay transport for both events.

The service attestation uses an ordinary kind-1 Nostr envelope containing the
existing `cvm_build_attestation` record, with `e`/`p` owner links and the aggregate
hash. This is a service provenance note, not a napplet manifest or a claim of
owner authorship. Its signer is the separately mounted service attestation key,
and must differ from the owner. Only the existing typed attestation builder may
select the signed content. No new manifest protocol or user-key custody is added.

Persist a prepare claim before local service signing. Only its winner may sign;
an interrupted prepare with no retained signed result remains unresolved. A
fresh process cannot invent another signature or request an owner signature.
Publishing requires a current matching receipt and intent; historical observation
validates the original canonical authorization without granting new effects.
Attestation publication additionally requires observation of the original owner
event. Missing acknowledgements query the original IDs, without republishing.

Proof requires restricted PostgreSQL, actual local relay/CLI transport, exact
signature/template checks, changed-event refusal, lost acknowledgements, fresh
process recovery, expiry, separate signer identities, and no redispatch after
unknown outcomes. These local mechanisms are not production certification.
