import { z } from "zod";
import { accountIdForPrincipal } from "../domain/account-command";
import { AccountStatusSchema, AccountTopUpStatusSchema, PrincipalSchema, type AccountTopUpStatus, type Principal } from "../phase-03/contracts";
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
export interface AccountTopUpStatusPort {
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
  constructor(private readonly options: Readonly<{ store: FundingStore; sessions: AccountSessionStatusPort; rails?: AccountTopUpStatusPort }>) {}

  async status(principalInput: unknown): Promise<RedactedAccountStatus> {
    const principal = PrincipalSchema.parse(principalInput) as Principal;
    const accountId = await accountIdForPrincipal(principal);
    const [funding, sessionInput, railInput] = await Promise.all([
      this.options.store.status(accountId),
      this.options.sessions.list({ accountId }),
      this.options.rails?.list({ accountId }) ?? Promise.resolve([]),
    ]);
    const base = funding ? AccountStatusSchema.parse(funding) : AccountStatusSchema.parse({ accountId, unit: "sat", available: "0", held: "0", topUps: [], admissions: [] });
    const sessions = SessionProjectionSchema.parse(sessionInput);
    const lifecycle = z.array(AccountTopUpStatusSchema).parse(railInput);
    const combined = new Map<string, AccountTopUpStatus>();
    for (const topUp of base.topUps) combined.set(`${topUp.rail}:${topUp.topUpId}`, topUp);
    for (const topUp of lifecycle) {
      const key = `${topUp.rail}:${topUp.topUpId}`;
      const credited = combined.get(key);
      combined.set(key, credited?.state === "credited" ? AccountTopUpStatusSchema.parse({ ...topUp, ...credited }) : topUp);
    }
    return freeze(ProjectionSchema.parse({
      ...base,
      topUps: [...combined.values()],
      activeSessions: sessions.active,
      resumableSessions: sessions.resumable,
      pendingActions: sessions.pendingActions,
    }));
  }
}
