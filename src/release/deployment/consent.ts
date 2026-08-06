import type { ReleaseAuthorizationRequest } from "../authorization";

export const OFFICIAL_APPROVAL_CHANNELS = ["nip46", "nwc", "cashu", "loopback_fixture"] as const;
export type OfficialApprovalChannel = typeof OFFICIAL_APPROVAL_CHANNELS[number];

export type OfficialConsentLaunchDescriptor = Readonly<{
  authorizationRequest: ReleaseAuthorizationRequest;
}>;

/** These are review-only launch descriptors. They deliberately omit NWC URIs,
 * Cashu proofs, signer sessions, credentials, and any transport handle. Plan
 * 07-20 owns opening the official consent surfaces. */
export type PendingConsentLaunchDescriptor = Readonly<{
  channel: Exclude<OfficialApprovalChannel, "loopback_fixture">;
  authorizationRequestSha256: string;
  expiresAtMs: number;
}>;

export function preparePendingConsentLaunchDescriptors(input: Readonly<{ authorizationRequest: ReleaseAuthorizationRequest }>): readonly PendingConsentLaunchDescriptor[] {
  return Object.freeze((["nip46", "nwc", "cashu"] as const).map((channel) => Object.freeze({
    channel,
    authorizationRequestSha256: input.authorizationRequest.authorizationRequestSha256,
    expiresAtMs: input.authorizationRequest.expiresAtMs,
  })));
}

/** The release request cannot launch either of these boundaries. NIP-46 is a
 * future napplet-owner signature at publication time, while NWC/Cashu is an
 * operator-controlled funding rail that must be selected exactly once before
 * a spend-bearing request can be authorized. Neither is an end-user consent
 * receipt and neither carries an endpoint, wallet URI, proof, or secret. */
export type PreApprovalPrerequisiteDescriptor =
  | Readonly<{
    kind: "operator_funding_rail";
    status: "selection_required";
    allowedChannels: readonly ["nwc", "cashu"];
  }>
  | Readonly<{
    kind: "owner_manifest_signature";
    protocol: "nip46";
    status: "deferred_to_publication";
  }>;

export function preparePreApprovalPrerequisites(): readonly PreApprovalPrerequisiteDescriptor[] {
  return Object.freeze([
    Object.freeze({ kind: "operator_funding_rail" as const, status: "selection_required" as const, allowedChannels: Object.freeze(["nwc", "cashu"] as const) }),
    Object.freeze({ kind: "owner_manifest_signature" as const, protocol: "nip46" as const, status: "deferred_to_publication" as const }),
  ]);
}

/** An injected official-consent boundary. It returns only public hashes and
 * opaque session references; native approval tokens never enter controller state. */
export interface OfficialConsentPort {
  launch(input: OfficialConsentLaunchDescriptor): Promise<Readonly<{
    approvalChannel: OfficialApprovalChannel;
    approverPrincipalSha256: string;
    consentSessionReferences: readonly string[];
    approvedAtMs: number;
    expiresAtMs: number;
  }>>;
}
