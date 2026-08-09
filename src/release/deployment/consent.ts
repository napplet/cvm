import type { ReleaseAuthorizationRequest } from "../authorization";
import type { OperatorFundingReadiness } from "./operator-funding";

/** Approval is a human review. Service wallets and the future owner signer are
 * prerequisites, never approval transports. */
export const OFFICIAL_APPROVAL_CHANNELS = ["human_review", "loopback_fixture"] as const;
export type OfficialApprovalChannel = typeof OFFICIAL_APPROVAL_CHANNELS[number];

export type OfficialConsentLaunchDescriptor = Readonly<{
  authorizationRequest: ReleaseAuthorizationRequest;
}>;

/** These are review-only launch descriptors. They deliberately omit NWC URIs,
 * Cashu proofs, signer sessions, credentials, and any transport handle. Plan
 * 07-20 owns opening the official consent surfaces. */
/** The release request cannot launch any of these boundaries. NIP-46 is a
 * future napplet-owner signature at publication time, while NWC and Cashu are
 * separately-required, service-controlled funding rails. Neither carries an
 * endpoint, wallet URI, proof, or secret. */
export type PreApprovalPrerequisiteDescriptor =
  | Readonly<{
    kind: "operator_funding_rail";
    rail: "nwc_lightning" | "cashu";
    status: "readiness_required" | "ready" | "invalid";
  }>
  | Readonly<{
    kind: "owner_manifest_signature";
    protocol: "nip46";
    status: "deferred_to_publication";
  }>;

export function preparePreApprovalPrerequisites(input?: Readonly<{ funding?: OperatorFundingReadiness }>): readonly PreApprovalPrerequisiteDescriptor[] {
  const railStatus = (rail: "nwc_lightning" | "cashu") => {
    const record = input?.funding?.rails.find((value) => value.rail === rail);
    if (!record) return "readiness_required" as const;
    return record.status === "ready" ? "ready" as const : "invalid" as const;
  };
  return Object.freeze([
    Object.freeze({ kind: "operator_funding_rail" as const, rail: "nwc_lightning" as const, status: railStatus("nwc_lightning") }),
    Object.freeze({ kind: "operator_funding_rail" as const, rail: "cashu" as const, status: railStatus("cashu") }),
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
