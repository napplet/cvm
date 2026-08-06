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
