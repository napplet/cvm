import { createHash } from "node:crypto";
import { canonicalJson } from "../../promotion/schema";

/**
 * The native deployment journal stores the short, Google-label-safe identity
 * rather than a caller supplied label. Billing must use this exact value when
 * joining detailed-export rows, so both paths share one canonical mapping.
 */
export function googleOperationLabel(operationId: string): string {
  return `g-${createHash("sha256").update(canonicalJson(operationId)).digest("hex").slice(0, 52)}`;
}
