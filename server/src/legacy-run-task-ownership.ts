import { and, eq, sql } from "drizzle-orm";
import { heartbeatRunEvents, type Db } from "@paperclipai/db";
import { forbidden } from "./errors.js";

export const LEGACY_ISSUE_OWNERSHIP_REVOKED_EVENT = "issue.legacy_run_ownership_revoked";

/**
 * Run context snapshots are periodically rewritten from in-memory state and
 * therefore cannot carry durable ownership decisions. This guard consults the
 * append-only run event written in the same transaction as an issue handoff.
 */
export async function assertLegacyRunTaskOwnership(
  db: Db,
  run: {
    id: string;
    companyId: string;
    runtimeMode: string;
    agentId?: string | null;
  } | null | undefined,
  issue: {
    id: string;
    companyId: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  },
) {
  if (run?.runtimeMode !== "legacy" || run.companyId !== issue.companyId || !run.agentId) return;
  const [revocation] = await db
    .select({ id: heartbeatRunEvents.id })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, issue.companyId),
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.agentId, run.agentId),
      eq(heartbeatRunEvents.eventType, LEGACY_ISSUE_OWNERSHIP_REVOKED_EVENT),
      sql`${heartbeatRunEvents.payload} @> ${JSON.stringify({ issueId: issue.id, ownerAgentId: run.agentId })}::jsonb`,
    ))
    .limit(1);
  if (!revocation) return;

  throw forbidden(
    issue.assigneeUserId
      ? "This task is assigned to a human; the outgoing run can no longer change it"
      : "This task has been handed to another owner; the outgoing run can no longer change it",
    { code: "issue_handed_off", issueId: issue.id },
  );
}
