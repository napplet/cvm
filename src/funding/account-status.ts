import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import { AccountStatusSchema, PrincipalSchema, type Principal } from "../phase-03/contracts";
import type { FundingStore } from "../persistence/funding-store";

const SessionProjectionSchema = z.object({
  active: z.array(z.object({ id: z.string().min(1) }).strict()),
  resumable: z.array(z.object({ id: z.string().min(1) }).strict()),
  pendingActions: z.array(z.object({ id: z.string().min(1), state: z.enum(["authorized", "pending", "reconciliation_pending"]) }).strict()),
}).strict();
const ProjectionSchema = AccountStatusSchema.extend({
  activeSessions: z.array(z.object({ id: z.string().min(1) }).strict()),
  resumableSessions: z.array(z.object({ id: z.string().min(1) }).strict()),
  pendingActions: z.array(z.object({ id: z.string().min(1), state: z.enum(["authorized", "pending", "reconciliation_pending"]) }).strict()),
}).strict();

export interface AccountSessionStatusPort {
  list(input: Readonly<{ accountId: string }>): Promise<unknown>;
}
export type RedactedAccountStatus = z.infer<typeof ProjectionSchema>;

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Account-only projection; rail material and raw session content never cross this seam. */
export class AccountStatusService {
  constructor(private readonly options: Readonly<{ store: FundingStore; sessions: AccountSessionStatusPort }>) {}

  async status(principalInput: unknown): Promise<RedactedAccountStatus> {
    const principal = PrincipalSchema.parse(principalInput) as Principal;
    const accountId = await accountIdForPrincipal(principal);
    const [funding, sessionInput] = await Promise.all([this.options.store.status(accountId), this.options.sessions.list({ accountId })]);
    const base = funding ? AccountStatusSchema.parse(funding) : AccountStatusSchema.parse({ accountId, unit: "sat", available: "0", held: "0", topUps: [], admissions: [] });
    const sessions = SessionProjectionSchema.parse(sessionInput);
    return freeze(ProjectionSchema.parse({
      ...base,
      activeSessions: sessions.active,
      resumableSessions: sessions.resumable,
      pendingActions: sessions.pendingActions,
    }));
  }
}
