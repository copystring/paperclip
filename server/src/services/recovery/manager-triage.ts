import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { budgetService } from "../budgets.js";
import { readChatControlRecoveryStop } from "../chat-control-recovery-stop.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { isHeartbeatWakeOnDemandEnabled } from "../heartbeat-policy.js";
import { persistActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { executeIssuePostCommitActions, issueService, type IssuePostCommitAction } from "../issues.js";
import { collectDispositionRepairSourceState } from "./disposition-repair.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./pause-hold-guard.js";

import { MANAGER_TRIAGE_ORIGIN, hasExplicitUserWake } from "./manager-triage-budget.js";
export { MANAGER_TRIAGE_ORIGIN } from "./manager-triage-budget.js";
const SCHEMA = "paperclip.recovery-manager-triage.v1";
type Issue = typeof issues.$inferSelect;
type Action = typeof issueRecoveryActions.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;
type Reservation = {
  schema: typeof SCHEMA;
  managerId: string;
  sourceOwnerId: string;
  sourceRunId: string;
  sourceStatusVersion: number;
  fingerprint: string;
  issueId: string;
  runId: string;
  attemptCount: 1;
  maxAttempts: 1;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function reservation(action: Action): Reservation | null {
  const value = record(action.evidence.managerTriage);
  if (value.schema !== SCHEMA || value.attemptCount !== 1 || value.maxAttempts !== 1 ||
      !Number.isSafeInteger(value.sourceStatusVersion) ||
      !["managerId", "sourceOwnerId", "sourceRunId", "fingerprint", "issueId", "runId"]
        .every(key => typeof value[key] === "string" && value[key])) return null;
  return value as unknown as Reservation;
}

/** The source ledger is never charged or reset by this independent repair lane. */
export function recoveryManagerTriageService(db: Db) {
  async function eligible(database: Db, source: Issue, action: Action, sourceRun: Run, managerId: string, readOnly = false) {
    const sourceMaximum = action.evidence.sourceMaxAttempts;
    if (!Number.isSafeInteger(sourceMaximum) || (sourceMaximum as number) < 1 ||
        action.evidence.sourceAttemptCount !== action.attemptCount || action.attemptCount < (sourceMaximum as number)) return false;
    if (action.companyId !== source.companyId || action.sourceIssueId !== source.id ||
        action.kind !== "deliberate_wait_without_target" || action.cause !== "deliberate_wait_without_target" ||
        action.status !== "active" || action.ownerType !== "board" ||
        record(action.wakePolicy).type !== "board_escalation" ||
        action.evidence.terminalReason !== "unchanged_source_state_exhausted" ||
        source.status !== "blocked" || !source.assigneeAgentId || source.assigneeUserId ||
        source.originKind === MANAGER_TRIAGE_ORIGIN || source.originKind === "chat_channel" || source.conversationAgentId ||
        sourceRun.companyId !== source.companyId || sourceRun.agentId !== source.assigneeAgentId ||
        sourceRun.status !== "succeeded" || sourceRun.errorCode || sourceRun.runtimeMode === "native" ||
        Boolean(sourceRun.controllerBootId && sourceRun.controllerLeaseExpiresAt && sourceRun.controllerLeaseExpiresAt.getTime() > Date.now()) ||
        action.evidence.latestRunId !== sourceRun.id ||
        (sourceRun.issueId !== source.id && record(sourceRun.contextSnapshot).issueId !== source.id)) return false;
    const unblockOwner = record(source.unblockDescriptor).owner;
    if (unblockOwner === "board" || record(unblockOwner).userId) return false;
    const [owner] = await database.select().from(agents).where(and(
      eq(agents.id, source.assigneeAgentId), eq(agents.companyId, source.companyId),
    )).limit(1);
    const [manager] = await database.select().from(agents).where(and(
      eq(agents.id, managerId), eq(agents.companyId, source.companyId),
    )).limit(1);
    if (!owner || owner.reportsTo !== managerId || managerId === owner.id || !manager ||
        !(await evaluateAgentInvokabilityFromDb(database, owner)).invokable ||
        !(await evaluateAgentInvokabilityFromDb(database, manager)).invokable ||
        !isHeartbeatWakeOnDemandEnabled(manager)) return false;
    const [state, pause, stop, budget, latest, company, children] = await Promise.all([
      collectDispositionRepairSourceState(database, { issue: source }),
      isAutomaticRecoverySuppressedByPauseHold(database, source.companyId, source.id),
      readChatControlRecoveryStop(database, { companyId: source.companyId, issueId: source.id,
        agentId: source.assigneeAgentId, sourceRunId: sourceRun.id }),
      readOnly ? Promise.resolve(null) : budgetService(database).getInvocationBlock(source.companyId, managerId, { projectId: source.projectId }),
      database.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, source.companyId), or(eq(heartbeatRuns.issueId, source.id),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${source.id}`),
      )).orderBy(sql`${heartbeatRuns.createdAt} desc`, sql`${heartbeatRuns.id} desc`).limit(1),
      database.select({ status: companies.status }).from(companies).where(eq(companies.id, source.companyId)).limit(1),
      database.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, source.companyId),
        eq(issues.parentId, source.id), inArray(issues.status, ["todo", "in_progress", "in_review"]),
        action.recoveryIssueId ? ne(issues.id, action.recoveryIssueId) : sql`true`,
      )).limit(1),
    ]);
    return !state.hasActiveExecutionPath && !state.hasDurableWaitingPath && !pause &&
      stop.kind === "clear" && !budget && latest[0]?.id === sourceRun.id &&
      company[0]?.status === "active" && children.length === 0;
  }

  async function reserve(actionId: string) {
    const [candidate] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId)).limit(1);
    if (!candidate) return null;
    const publications: ActivityPublication[] = [];
    const result = await db.transaction(async tx => {
      // Same ordering as issue create/privacy updates; never take privacy after an issue lock.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${candidate.companyId}`}, 0))`);
      const [source] = await tx.select().from(issues).where(and(
        eq(issues.id, candidate.sourceIssueId), eq(issues.companyId, candidate.companyId),
      )).for("update");
      const [action] = await tx.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.id, actionId), eq(issueRecoveryActions.companyId, candidate.companyId),
        eq(issueRecoveryActions.sourceIssueId, candidate.sourceIssueId),
      )).for("update");
      if (!source || !action) return null;
      const existing = reservation(action);
      if (existing) return action.recoveryIssueId === existing.issueId ? existing : null;
      // An unknown/malformed reservation or existing repair is not a fresh budget.
      if (action.evidence.managerTriage !== undefined || action.recoveryIssueId) return null;
      const runId = action.evidence.latestRunId;
      if (typeof runId !== "string" || !source.assigneeAgentId) return null;
      const [sourceRun] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, source.companyId),
      )).limit(1);
      const [owner] = await tx.select().from(agents).where(and(
        eq(agents.id, source.assigneeAgentId), eq(agents.companyId, source.companyId),
      )).limit(1);
      if (!sourceRun || !owner?.reportsTo ||
          !(await eligible(tx as unknown as Db, source, action, sourceRun, owner.reportsTo))) return null;
      const managerId = owner.reportsTo;
      const child = await issueService(db).create(source.companyId, {
        title: `Repair the execution path for ${source.identifier ?? source.id}`,
        description: [
          `Perform one bounded technical triage of recovery action ${action.id} for ${source.identifier ?? source.id}.`,
          `The source owner ${source.assigneeAgentId} exhausted its disposition allowance; preserve its ownership and counters.`,
          `Inspect the recorded source run and diagnose the concrete internal execution problem under existing authority. If implementation is required, use an existing repair task or create one bounded repair task directly under source ${source.id}, not under this triage task; record that repair as a first-class source dependency. Finish this triage deliverable after the repair handoff is saved, without waiting for an extra triage invocation.`,
          "Do not replay unknown effects, reset budgets, bypass Stop/HOLD, make a human decision, or publish without authorization. Never create a manager-triage chain. If a real human decision is needed, state the evidence, precise question, options and next owner on this task.",
          "Persist the diagnosis and the actual next execution or decision path. A status summary alone is not a repair. This manager handoff has one separately reserved invocation; no automatic extra manager turns are authorized.",
        ].join("\n\n"),
        status: "todo", priority: source.priority, parentId: source.id, projectId: source.projectId,
        goalId: source.goalId, assigneeAgentId: managerId, originKind: MANAGER_TRIAGE_ORIGIN,
        originId: action.id, idempotencyKey: `manager-triage:${action.id}`,
        responsibleUserId: sourceRun.responsibleUserId ?? source.responsibleUserId,
        trustExplicitResponsibleUserId: true, inheritExecutionWorkspaceFromIssueId: source.id,
      }, tx);
      const now = new Date();
      const context = { issueId: child.id, taskId: child.id, source: MANAGER_TRIAGE_ORIGIN,
        wakeReason: MANAGER_TRIAGE_ORIGIN, managerTriageActionId: action.id };
      const [wake] = await tx.insert(agentWakeupRequests).values({
        companyId: source.companyId, agentId: managerId, source: "automation", triggerDetail: "system",
        reason: MANAGER_TRIAGE_ORIGIN, payload: context, status: "queued",
        requestedByActorType: "system", idempotencyKey: `manager-triage:${action.id}:1`,
      }).returning();
      const [run] = await tx.insert(heartbeatRuns).values({
        companyId: source.companyId, agentId: managerId, issueId: child.id,
        invocationSource: "automation", triggerDetail: "system", status: "scheduled_retry",
        wakeupRequestId: wake.id, scheduledRetryAt: now, scheduledRetryAttempt: 1,
        scheduledRetryReason: MANAGER_TRIAGE_ORIGIN, contextSnapshot: context,
        responsibleUserId: sourceRun.responsibleUserId ?? source.responsibleUserId,
      }).returning();
      await tx.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
      const state: Reservation = { schema: SCHEMA, managerId, sourceOwnerId: source.assigneeAgentId,
        sourceRunId: sourceRun.id, sourceStatusVersion: source.statusVersion, fingerprint: action.fingerprint,
        issueId: child.id, runId: run.id, attemptCount: 1, maxAttempts: 1 };
      await tx.update(issueRecoveryActions).set({ recoveryIssueId: child.id,
        evidence: { ...action.evidence, managerTriage: state },
        nextAction: `Manager triage: ${child.identifier ?? child.id}. Original owner and source budget are unchanged.`,
        updatedAt: now,
      }).where(eq(issueRecoveryActions.id, action.id));
      const { publication } = await persistActivity(tx as unknown as Db, {
        companyId: source.companyId, actorType: "system", actorId: "recovery",
        agentId: managerId, action: "issue.recovery_manager_triage_reserved",
        entityType: "issue_recovery_action", entityId: action.id,
        details: { sourceIssueId: source.id, sourceOwnerId: source.assigneeAgentId,
          sourceAttemptCount: action.attemptCount, managerId, managerIssueId: child.id,
          managerRunId: run.id, managerAttempt: 1, managerMaxAttempts: 1 },
      });
      publications.push(publication);
      return state;
    });
    for (const publication of publications) publishActivity(publication);
    return result;
  }

  // Called by the final dispatch fence before taking child/run locks. Parent-
  // first locking also serializes ancestor Hold/Stop and FK-backed approvals.
  async function lockSource(companyId: string, actionId: string) {
    const [hint] = await db.select({ sourceIssueId: issueRecoveryActions.sourceIssueId }).from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.id, actionId), eq(issueRecoveryActions.companyId, companyId))).limit(1);
    if (!hint) return;
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${companyId}`}, 0))`);
    await db.execute(sql`with recursive ancestry as (
      select id, parent_id, 0 as depth from issues where id = ${hint.sourceIssueId} and company_id = ${companyId}
      union all select p.id, p.parent_id, a.depth + 1 from issues p join ancestry a on p.id = a.parent_id
        where p.company_id = ${companyId}
    ) select node.id from issues node join ancestry a on node.id = a.id
      order by a.depth desc for update of node`);
    await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.id, actionId), eq(issueRecoveryActions.companyId, companyId))).for("update");
  }

  async function dispatchBlock(run: Run, readOnly = false): Promise<string | null> {
    const context = record(run.contextSnapshot);
    const issueId = typeof context.issueId === "string" ? context.issueId : run.issueId;
    if (!issueId) return null;
    const [child] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId))).limit(1);
    if (child?.originKind !== MANAGER_TRIAGE_ORIGIN) return context.managerTriageActionId ? "invalid_manager_triage_binding" : null;
    // A new authenticated human input is a new intent, not automatic recovery.
    // Its ordinary native ownership, Hold and budget gates still apply.
    if (await hasExplicitUserWake(db, run)) return null;
    const [action] = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.recoveryIssueId, child.id),
    )).limit(1);
    const state = action && reservation(action);
    if (!action || !state || state.runId !== run.id || state.issueId !== child.id ||
        state.managerId !== run.agentId || child.assigneeAgentId !== run.agentId ||
        !["todo", "in_progress"].includes(child.status)) return "manager_triage_slot_not_reserved";
    const [source] = await db.select().from(issues).where(and(
      eq(issues.id, action.sourceIssueId), eq(issues.companyId, run.companyId),
    )).limit(1);
    const [sourceRun] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, state.sourceRunId), eq(heartbeatRuns.companyId, run.companyId),
    )).limit(1);
    if (!source || !sourceRun || source.statusVersion !== state.sourceStatusVersion ||
        source.assigneeAgentId !== state.sourceOwnerId || action.fingerprint !== state.fingerprint ||
        !(await eligible(db, source, action, sourceRun, state.managerId, readOnly))) return "manager_triage_source_changed_or_held";
    if (!readOnly && await budgetService(db).getInvocationBlock(child.companyId, run.agentId,
      { issueId: child.id, projectId: child.projectId })) return "manager_triage_budget_blocked";
    return null;
  }

  /** A spent turn must leave an actionable receipt, never an ownerless live task. */
  async function settle(actionId: string) {
    const [hint] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId)).limit(1);
    if (!hint || !reservation(hint)) return false;
    const publications: ActivityPublication[] = [];
    const postCommitActions: IssuePostCommitAction[] = [];
    const changed = await db.transaction(async tx => {
      const database = tx as unknown as Db;
      await recoveryManagerTriageService(database).lockSource(hint.companyId, actionId);
      const [action] = await tx.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.id, actionId), eq(issueRecoveryActions.companyId, hint.companyId),
      )).limit(1);
      const state = action && reservation(action);
      if (!action || !state || action.status !== "active" || action.recoveryIssueId !== state.issueId ||
          record(action.evidence.managerTriage).settledAt) return false;
      const [child] = await tx.select().from(issues).where(and(
        eq(issues.id, state.issueId), eq(issues.companyId, action.companyId),
      )).for("update");
      const [run] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, state.runId), eq(heartbeatRuns.companyId, action.companyId),
      )).for("update");
      if (!child || !run || child.originKind !== MANAGER_TRIAGE_ORIGIN ||
          ["done", "cancelled"].includes(child.status) ||
          !["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.status)) return false;
      // Do not replace a real wait, human decision or a newer authorized turn.
      const paths = await collectDispositionRepairSourceState(database, { issue: child,
        excludeRunId: run.id, excludeWakeupRequestId: run.wakeupRequestId });
      if (paths.hasActiveExecutionPath || paths.hasDurableWaitingPath || child.unblockDescriptor ||
          await isAutomaticRecoverySuppressedByPauseHold(database, child.companyId, child.id)) return false;
      const question = `The reserved manager turn ended (${run.status}${run.errorCode ? `: ${run.errorCode}` : ""}) without a completed triage or a durable next step. Inspect run ${run.id}. Should a new, explicitly scoped repair be authorized, or should this repair be cancelled? Preserve the source owner and its exhausted allowance; no automatic extra manager invocation is available.`;
      const updated = await issueService(db).update(child.id, { status: "blocked",
        companyGuard: child.companyId,
        unblockDescriptor: { owner: "board", action: question } }, tx, publications, postCommitActions);
      if (!updated) return false;
      await issueService(db).addComment(child.id, question, {}, { authorType: "system" }, tx);
      await tx.update(issueRecoveryActions).set({
        evidence: { ...action.evidence, managerTriage: { ...record(action.evidence.managerTriage),
          phase: "exhausted", settledAt: new Date().toISOString(), terminalRunStatus: run.status } },
        nextAction: `Manager triage ${child.identifier ?? child.id} needs an explicit decision: inspect its recorded run, authorize a new scoped repair, or cancel. Source ownership and counters are unchanged.`,
        updatedAt: new Date(),
      }).where(eq(issueRecoveryActions.id, action.id));
      const { publication } = await persistActivity(database, { companyId: action.companyId, actorType: "system",
        actorId: "recovery", action: "issue.recovery_manager_triage_exhausted", entityType: "issue_recovery_action",
        entityId: action.id, details: { sourceIssueId: action.sourceIssueId, managerIssueId: child.id,
          managerRunId: run.id, terminalRunStatus: run.status, managerAttempt: 1, managerMaxAttempts: 1 } });
      publications.push(publication);
      return true;
    });
    for (const publication of publications) publishActivity(publication);
    await executeIssuePostCommitActions(db, postCommitActions);
    return changed;
  }

  return { reserve, dispatchBlock, lockSource, settle };
}
