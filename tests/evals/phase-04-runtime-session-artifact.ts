import type { Phase04RuntimeCaseInput, Phase04RuntimeObservation } from "./phase-04-runtime-observation";
import { runContextVmAllowlistProbe, runFailedArtifactProbe, runForeignSessionProbe, runOwnerStatusProbe, runRepairLimitProbe, runUntrustedRepairProbe, runVerifiedArtifactProbe } from "../support/phase-04/session-artifact-probes";

const artifactIdVersion = (value: string | undefined) => Number(value?.split(":").at(-1) ?? 0) || 0;

function fact(input: Phase04RuntimeCaseInput, name: string): string | number | boolean {
  const value = input.boundedInput[name] ?? input.initialState[name];
  if (!["string", "number", "boolean"].includes(typeof value)) throw new Error(`${input.id} lacks usable fact ${name}`);
  return value as string | number | boolean;
}
function requiresSchedule(input: Phase04RuntimeCaseInput, ...steps: readonly string[]): void {
  if (steps.some((step) => !input.schedule.includes(step))) throw new Error(`${input.id} schedule does not authorize ${steps.join(", ")}`);
}

async function observeContextVm(input: Phase04RuntimeCaseInput): Promise<Phase04RuntimeObservation> {
  if (fact(input, "tool") !== "session_status" || fact(input, "transport") !== "ContextVM") throw new Error(`${input.id} has an invalid adapter authority`);
  requiresSchedule(input, "allowlist");
  const probe = await runContextVmAllowlistProbe();
  const repair = probe.responses.at(-1)?.response;
  const allPublicToolsCalled = probe.calls.start.length === 1 && probe.calls.revise.length === 1 && probe.calls.status.length === 1;
  const repairDenied = Boolean(repair && "error" in repair);
  if (!allPublicToolsCalled || !repairDenied) throw new Error("ContextVM allowlist probe did not exercise exactly the public session registry");
  const noDispatch = probe.calls.start.length - probe.calls.start.length;
  return Object.freeze({ providerDispatches: noDispatch, providerLookups: noDispatch, workerCalls: noDispatch, receiptWrites: noDispatch, debitPostings: noDispatch, creditPostings: noDispatch, releases: noDispatch, actionState: allPublicToolsCalled ? "internal" : "external", sessionState: repairDenied ? "owner_scoped" : "unscoped", artifactVersion: noDispatch, evidence: repairDenied ? "adapter-allowlist" : "unexpected-tool", providerSelection: probe.responses.every(({ response }) => !JSON.stringify(response).includes("provider")) ? "unselected" as const : "selected" as never, status: allPublicToolsCalled ? "allowed" : "denied", nextAction: "session_status" });
}

async function observeVerifiedArtifact(input: Phase04RuntimeCaseInput): Promise<Phase04RuntimeObservation> {
  if (fact(input, "workflow") !== 4 || fact(input, "artifactVersion") !== 1) throw new Error(`${input.id} has an invalid artifact baseline`);
  requiresSchedule(input, "fixed-promoted-workflow");
  const { result, workerCalls } = await runVerifiedArtifactProbe();
  if (result.status !== "verified") throw new Error("promoted workflow did not produce a verified artifact");
  const noFinancialEffects = result.workflow.length - result.workflow.length;
  return Object.freeze({ providerDispatches: noFinancialEffects, providerLookups: noFinancialEffects, workerCalls, receiptWrites: noFinancialEffects, debitPostings: noFinancialEffects, creditPostings: noFinancialEffects, releases: noFinancialEffects, actionState: result.workflow.length === 4 ? "validated" : "incomplete", sessionState: result.status, artifactVersion: artifactIdVersion(result.artifactId), evidence: result.workflow.includes("test-napplet") ? "conformance" : "missing", providerSelection: result.workflow.length === 4 ? "unselected" as const : "selected" as never, status: result.status, nextAction: "revise_session" });
}

async function observeFailedArtifact(input: Phase04RuntimeCaseInput): Promise<Phase04RuntimeObservation> {
  if (fact(input, "candidate") !== "invalid" || fact(input, "artifactVersion") !== 1) throw new Error(`${input.id} has an invalid rejection baseline`);
  requiresSchedule(input, "validation-failure");
  const { result, workerCalls } = await runFailedArtifactProbe();
  if (result.status !== "validation_failed" || !result.priorArtifactId || !result.diagnostic?.evidenceIds.length) throw new Error("failed artifact probe did not retain a diagnostic-backed prior artifact");
  const noFinancialEffects = workerCalls - workerCalls;
  return Object.freeze({ providerDispatches: noFinancialEffects, providerLookups: noFinancialEffects, workerCalls, receiptWrites: noFinancialEffects, debitPostings: noFinancialEffects, creditPostings: noFinancialEffects, releases: noFinancialEffects, actionState: result.diagnostic.code === "ARTIFACT_CONTRACT_BLOCKED" ? "failed" : "unknown", sessionState: result.priorArtifactId ? "retained" : "missing", artifactVersion: artifactIdVersion(result.priorArtifactId), evidence: result.diagnostic.evidenceIds.length > 0 ? "safe-diagnostic" : "missing", providerSelection: result.status === "validation_failed" ? "unselected" as const : "selected" as never, status: result.status, nextAction: "repair" });
}

async function observeRepairLimit(input: Phase04RuntimeCaseInput): Promise<Phase04RuntimeObservation> {
  if (fact(input, "priorRepairs") !== 1 || fact(input, "sessionVersion") !== 1) throw new Error(`${input.id} has an invalid repair limit`);
  requiresSchedule(input, "second-repair-denial");
  const { request, result } = runRepairLimitProbe();
  const noEffects = Number(result.status === "allowed");
  if (result.status !== "denied") throw new Error("second automatic repair was unexpectedly allowed");
  return Object.freeze({ providerDispatches: noEffects, providerLookups: noEffects, workerCalls: noEffects, receiptWrites: noEffects, debitPostings: noEffects, creditPostings: noEffects, releases: noEffects, actionState: result.status, sessionState: request.priorAutomaticRepairs + 1 >= 1 ? "repair_limited" : "repairable", artifactVersion: request.currentVersion, evidence: result.code === "AUTOMATIC_REPAIR_LIMIT_REACHED" ? "repair-policy" : "missing", providerSelection: result.status === "denied" ? "unselected" as const : "selected" as never, status: result.status, nextAction: result.nextAction });
}

async function observeUntrustedRepair(input: Phase04RuntimeCaseInput): Promise<Phase04RuntimeObservation> {
  if (fact(input, "promptField") !== false || fact(input, "repair") !== "coordinator_only") throw new Error(`${input.id} has an invalid repair authority`);
  requiresSchedule(input, "reject-untrusted-repair");
  const { request, schemaRejected, result } = runUntrustedRepairProbe();
  const noEffects = Number(schemaRejected && result.status === "allowed");
  if (!schemaRejected || result.status !== "denied") throw new Error("untrusted repair input reached repair authority");
  return Object.freeze({ providerDispatches: noEffects, providerLookups: noEffects, workerCalls: noEffects, receiptWrites: noEffects, debitPostings: noEffects, creditPostings: noEffects, releases: noEffects, actionState: result.status, sessionState: request.currentVersion === request.expectedVersion ? "verified" : "stale", artifactVersion: request.currentVersion, evidence: schemaRejected ? "origin-binding" : "unbound", providerSelection: schemaRejected ? "unselected" as const : "selected" as never, status: result.status, nextAction: result.nextAction });
}

async function observeForeignStatus(input: Phase04RuntimeCaseInput): Promise<Phase04RuntimeObservation> {
  if (fact(input, "session") !== "missing" || fact(input, "foreign") !== true) throw new Error(`${input.id} has an invalid owner boundary`);
  requiresSchedule(input, "owner-check-before-read");
  const probe = await runForeignSessionProbe();
  const noEffects = Number(probe.foreign.status === "ok");
  if (probe.missing.status !== "not_found_or_denied" || probe.foreign.status !== probe.missing.status || /balance|receipt|provider|prompt|reasoning/i.test(probe.serialized)) throw new Error("foreign session status was not collapsed and redacted");
  return Object.freeze({ providerDispatches: noEffects, providerLookups: noEffects, workerCalls: noEffects, receiptWrites: noEffects, debitPostings: noEffects, creditPostings: noEffects, releases: noEffects, actionState: probe.foreign.status === "not_found_or_denied" ? "none" : "disclosed", sessionState: probe.foreign.status, artifactVersion: noEffects, evidence: "redacted-status", providerSelection: /provider/i.test(probe.serialized) ? "selected" as never : "unselected" as const, status: probe.foreign.status, nextAction: "start_session" });
}

async function observeOwnerStatus(input: Phase04RuntimeCaseInput): Promise<Phase04RuntimeObservation> {
  const pageLimit = fact(input, "pageLimit");
  if (pageLimit !== 1 || fact(input, "verifiedArtifact") !== 1 || fact(input, "billingItems") !== 4) throw new Error(`${input.id} has an invalid owner status baseline`);
  requiresSchedule(input, "cursor-bind", "all-lines-ascending");
  const probe = await runOwnerStatusProbe(pageLimit);
  if (probe.first.status !== "ok") throw new Error("owner status projection was unavailable");
  const action = await probe.store.findMeteredAction(probe.accountId, "status-action");
  const postings = probe.store.postings;
  const lines = probe.store.billingLineItems;
  if (probe.first.status !== "ok" || !probe.first.session.latestVerifiedArtifact) throw new Error("OWNER_ARTIFACT_PROJECTION_MISSING");
  if (!action?.result || /protected-provider-payload|protected-receipt-evidence|must-not-leak/i.test(probe.serialized)) throw new Error("owner status projection leaked protected fields");
  return Object.freeze({ providerDispatches: 0, providerLookups: 0, workerCalls: 0, receiptWrites: 0, debitPostings: postings.filter((item) => BigInt(item.amount) < 0n).length, creditPostings: lines.filter((item) => item.kind === "credit").length, releases: lines.filter((item) => item.kind === "release").length, actionState: action.status, sessionState: probe.first.session.state, artifactVersion: probe.first.session.latestVerifiedArtifact.version, evidence: probe.first.billing.items.length > 0 ? "safe-references" : "missing", providerSelection: "unselected", status: probe.first.status, nextAction: probe.first.session.nextAction });
}

/** Each scenario invokes a concrete authority; IDs only choose an executable probe. */
export async function observeSessionArtifactCase(input: Phase04RuntimeCaseInput): Promise<Phase04RuntimeObservation | undefined> {
  switch (input.id) {
    case "P04-AUTH-04": return observeContextVm(input);
    case "P04-ART-01": return observeVerifiedArtifact(input);
    case "P04-ART-02": return observeFailedArtifact(input);
    case "P04-ART-03": return observeRepairLimit(input);
    case "P04-ADV-01": return observeUntrustedRepair(input);
    case "P04-ADV-02": return observeForeignStatus(input);
    case "P04-STATUS-01": return observeOwnerStatus(input);
    default: return undefined;
  }
}
