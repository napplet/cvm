import type { MeteredGenerationService } from "../phase-04/metered-generation-service";

type GenerationSurface = Pick<MeteredGenerationService, "startSession" | "reviseSession" | "dispatchVerifiedCredit" | "reconcileOutstandingWakeDispatches" | "completeResumedAction">;

/** Coordinator-private one-time binding for the real funding/generation cycle. */
export class SealedProductionGenerationFacade implements GenerationSurface {
  #service: GenerationSurface | undefined;
  bind(service: GenerationSurface): void {
    if (this.#service || !service || typeof service.startSession !== "function" || typeof service.reviseSession !== "function" || typeof service.dispatchVerifiedCredit !== "function" || typeof service.reconcileOutstandingWakeDispatches !== "function" || typeof service.completeResumedAction !== "function") throw new Error("PRODUCTION_GENERATION_BINDING_REQUIRED");
    this.#service = service;
  }
  #get(): GenerationSurface { if (!this.#service) throw new Error("PRODUCTION_GENERATION_NOT_BOUND"); return this.#service; }
  startSession(...args: Parameters<MeteredGenerationService["startSession"]>) { return this.#get().startSession(...args); }
  reviseSession(...args: Parameters<MeteredGenerationService["reviseSession"]>) { return this.#get().reviseSession(...args); }
  dispatchVerifiedCredit(...args: Parameters<MeteredGenerationService["dispatchVerifiedCredit"]>) { return this.#get().dispatchVerifiedCredit(...args); }
  reconcileOutstandingWakeDispatches(...args: Parameters<MeteredGenerationService["reconcileOutstandingWakeDispatches"]>) { return this.#get().reconcileOutstandingWakeDispatches(...args); }
  completeResumedAction(...args: Parameters<MeteredGenerationService["completeResumedAction"]>) { return this.#get().completeResumedAction(...args); }
}
