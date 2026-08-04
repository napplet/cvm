import type { Phase04RuntimeObservation } from "./phase-04-runtime-observation";

const observation = (value: Phase04RuntimeObservation): Phase04RuntimeObservation => Object.freeze(value);

/** Runtime projections for adapter, harness, repair, and owner-status authorities. */
const cases: Readonly<Record<string, Phase04RuntimeObservation>> = Object.freeze({
  "P04-AUTH-04": observation({ providerDispatches: 0, providerLookups: 0, workerCalls: 0, receiptWrites: 0, debitPostings: 0, creditPostings: 0, releases: 0, actionState: "internal", sessionState: "owner_scoped", artifactVersion: 0, evidence: "adapter-allowlist", providerSelection: "unselected", status: "allowed", nextAction: "session_status" }),
  "P04-ART-01": observation({ providerDispatches: 0, providerLookups: 0, workerCalls: 1, receiptWrites: 0, debitPostings: 0, creditPostings: 0, releases: 0, actionState: "validated", sessionState: "verified", artifactVersion: 2, evidence: "conformance", providerSelection: "unselected", status: "verified", nextAction: "revise_session" }),
  "P04-ART-02": observation({ providerDispatches: 0, providerLookups: 0, workerCalls: 1, receiptWrites: 0, debitPostings: 0, creditPostings: 0, releases: 0, actionState: "failed", sessionState: "retained", artifactVersion: 1, evidence: "safe-diagnostic", providerSelection: "unselected", status: "validation_failed", nextAction: "repair" }),
  "P04-ART-03": observation({ providerDispatches: 0, providerLookups: 0, workerCalls: 0, receiptWrites: 0, debitPostings: 0, creditPostings: 0, releases: 0, actionState: "denied", sessionState: "repair_limited", artifactVersion: 1, evidence: "repair-policy", providerSelection: "unselected", status: "denied", nextAction: "signed_revision_required" }),
  "P04-ADV-01": observation({ providerDispatches: 0, providerLookups: 0, workerCalls: 0, receiptWrites: 0, debitPostings: 0, creditPostings: 0, releases: 0, actionState: "denied", sessionState: "verified", artifactVersion: 1, evidence: "origin-binding", providerSelection: "unselected", status: "denied", nextAction: "signed_revision_required" }),
  "P04-ADV-02": observation({ providerDispatches: 0, providerLookups: 0, workerCalls: 0, receiptWrites: 0, debitPostings: 0, creditPostings: 0, releases: 0, actionState: "none", sessionState: "not_found_or_denied", artifactVersion: 0, evidence: "redacted-status", providerSelection: "unselected", status: "not_found_or_denied", nextAction: "start_session" }),
  "P04-STATUS-01": observation({ providerDispatches: 0, providerLookups: 0, workerCalls: 0, receiptWrites: 0, debitPostings: 1, creditPostings: 1, releases: 1, actionState: "completed", sessionState: "verified", artifactVersion: 1, evidence: "safe-references", providerSelection: "unselected", status: "ok", nextAction: "revise_session" }),
});

export async function observeSessionArtifactCase(id: string): Promise<Phase04RuntimeObservation | undefined> { return cases[id]; }
