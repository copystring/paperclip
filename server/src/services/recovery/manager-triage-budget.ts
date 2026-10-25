import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

export const MANAGER_TRIAGE_ORIGIN = "recovery_manager_triage";
type Run = typeof heartbeatRuns.$inferSelect;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function issueBinding(run: Run) {
  const candidate = run.issueId ?? record(run.contextSnapshot).issueId;
  return typeof candidate === "string" && isUuidLike(candidate) ? candidate : null;
}

/** Only durable, same-task user provenance grants a new intent after auto triage. */
export async function hasExplicitUserWake(db: Db, run: Run) {
  const issueId = issueBinding(run);
  if (!issueId) return false;
  let current: Run | undefined = run;
  const seen = new Set<string>();
  for (let depth = 0; current && depth < 32; depth++) {
    if (seen.has(current.id) || current.companyId !== run.companyId || current.agentId !== run.agentId ||
        issueBinding(current) !== issueId) return false;
    seen.add(current.id);
    if (current.wakeupRequestId) {
      const [wake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.id, current.wakeupRequestId), eq(agentWakeupRequests.companyId, run.companyId),
        eq(agentWakeupRequests.agentId, run.agentId), eq(agentWakeupRequests.runId, current.id),
        eq(agentWakeupRequests.requestedByActorType, "user"), sql`${agentWakeupRequests.requestedByActorId} is not null`,
      )).limit(1);
      if (wake) return true;
    }
    if (!current.retryOfRunId) return false;
    [current] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, current.retryOfRunId), eq(heartbeatRuns.companyId, run.companyId),
    )).limit(1);
  }
  return false;
}

export async function isAutomaticManagerTriageRun(db: Db, run: Run) {
  if (typeof record(run.contextSnapshot).managerTriageActionId !== "string") {
    const issueId = issueBinding(run);
    if (!issueId) return false;
    const [issue] = await db.select({ originKind: issues.originKind }).from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId))).limit(1);
    if (issue?.originKind !== MANAGER_TRIAGE_ORIGIN) return false;
  }
  return !(await hasExplicitUserWake(db, run));
}

export async function managerTriageWakeAllowed(db: Db, input: {
  companyId: string; issueId: string; agentId: string;
  actorType?: string | null; actorId?: string | null; context: Record<string, unknown>;
}) {
  if (input.actorType === "user" && input.actorId) return true;
  const priorId = input.context.retryOfRunId;
  if (typeof priorId !== "string" || !isUuidLike(priorId)) return false;
  const [prior] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, priorId),
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
    sql`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${input.issueId}`,
  )).limit(1);
  return Boolean(prior && await hasExplicitUserWake(db, prior));
}
