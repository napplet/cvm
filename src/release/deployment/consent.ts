import type { ReleaseAuthorizationRequest } from "../authorization";

export const OFFICIAL_APPROVAL_CHANNELS = ["nip46", "nwc", "cashu", "loopback_fixture"] as const;
export type OfficialApprovalChannel = typeof OFFICIAL_APPROVAL_CHANNELS[number];

export type OfficialConsentLaunchDescriptor = Readonly<{
  authorizationRequest: ReleaseAuthorizationRequest;
}>;

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
