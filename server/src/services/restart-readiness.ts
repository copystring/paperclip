import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { idleWorkSnapshot } from "./task-admission.js";
import { readIdleLocalWork } from "./idle-local-work.js";

export interface RestartDrainStatus {
  ownerId?: string;
  draining: boolean;
  startedAt: Date | null;
  expiresAt: Date | null;
  activeRuns: number;
  pendingWakes: number;
}

export type RestartReadinessBlocker = {
  code:
    | "drain_missing" | "owner_mismatch" | "drain_expired"
    | "process_runs_active" | "process_wakes_pending" | "local_work_active"
    | "database_effects_active" | "plugins_busy" | "generation_changed"
    | "evidence_unavailable";
  count?: number;
};

export interface RestartReadiness {
  version: 1;
  status: "ready" | "blocked" | "unknown";
  ownerId: string;
  startedAt: string | null;
  expiresAt: string | null;
  serverPid: number;
  generation: number | null;
  blockers: RestartReadinessBlocker[];
}

type InspectIdlePlugins = (hold: { ownerId: string; expiresAt: number }) => Promise<{
  backgroundWork: "none" | "present" | "unknown";
  pluginIds: string[];
}>;

const unknownCode: RestartReadinessBlocker = { code: "evidence_unavailable" };

function report(
  ownerId: string,
  status: RestartReadiness["status"],
  drain: RestartDrainStatus,
  generation: number | null,
  blockers: RestartReadinessBlocker[],
): RestartReadiness {
  const iso = (value: Date | null): string | null => value && Number.isFinite(value.getTime()) ? value.toISOString() : null;
  return {
    version: 1,
    status,
    ownerId,
    startedAt: iso(drain.startedAt),
    expiresAt: iso(drain.expiresAt),
    serverPid: process.pid,
    generation,
    blockers,
  };
}

function sameDrain(before: RestartDrainStatus, after: RestartDrainStatus, ownerId: string): boolean {
  return before.draining && after.draining && before.ownerId === ownerId && after.ownerId === ownerId
    && before.activeRuns === 0 && before.pendingWakes === 0 && after.activeRuns === 0 && after.pendingWakes === 0
    && before.startedAt !== null && after.startedAt?.getTime() === before.startedAt.getTime()
    && before.expiresAt !== null && after.expiresAt?.getTime() === before.expiresAt.getTime();
}

/**
 * Certifies only that this exact owner-bound drain currently has no in-flight
 * process, local, database, or plugin work. Durable backlog and configured
 * ingress are intentionally outside this restart-specific contract.
 */
export async function readRestartReadiness(
  db: Db,
  getDrainStatus: () => RestartDrainStatus,
  ownerId: string,
  inspectPlugins?: InspectIdlePlugins,
  now: () => number = Date.now,
  inspectLocal: typeof readIdleLocalWork = readIdleLocalWork,
): Promise<RestartReadiness> {
  const initialDrain = getDrainStatus();
  const initialSnapshot = idleWorkSnapshot();
  const fail = (blockers: RestartReadinessBlocker[], status: "blocked" | "unknown" = "blocked") =>
    report(ownerId, status, initialDrain, initialSnapshot.generation, blockers);

  if (!initialDrain.draining || !initialDrain.ownerId) return fail([{ code: "drain_missing" }]);
  if (!ownerId || initialDrain.ownerId !== ownerId) return fail([{ code: "owner_mismatch" }]);
  if (!initialDrain.startedAt || !initialDrain.expiresAt || initialDrain.expiresAt.getTime() <= now()) {
    return fail([{ code: "drain_expired" }]);
  }
  if (!Number.isSafeInteger(initialDrain.activeRuns) || initialDrain.activeRuns < 0
    || !Number.isSafeInteger(initialDrain.pendingWakes) || initialDrain.pendingWakes < 0
    || !Number.isFinite(initialDrain.startedAt.getTime()) || !Number.isFinite(initialDrain.expiresAt.getTime())) {
    return fail([unknownCode], "unknown");
  }
  const blockers: RestartReadinessBlocker[] = [];
  if (initialDrain.activeRuns > 0) blockers.push({ code: "process_runs_active", count: initialDrain.activeRuns });
  if (initialDrain.pendingWakes > 0) blockers.push({ code: "process_wakes_pending", count: initialDrain.pendingWakes });
  if (initialSnapshot.active !== 0) blockers.push({ code: "local_work_active", count: initialSnapshot.active });
  if (blockers.length) return fail(blockers);
  if (!inspectPlugins) return fail([unknownCode], "unknown");

  try {
    const local = await inspectLocal({ purpose: "restart" });
    if (local === "unknown") return fail([unknownCode], "unknown");
    if (local === "present") return fail([{ code: "local_work_active" }]);
    if (local !== "none") return fail([unknownCode], "unknown");
    const beforePlugins = getDrainStatus();
    if (!sameDrain(initialDrain, beforePlugins, ownerId) || initialSnapshot.generation !== idleWorkSnapshot().generation
      || idleWorkSnapshot().active !== 0 || initialDrain.expiresAt.getTime() <= now()) {
      return fail([{ code: "generation_changed" }], "unknown");
    }
    const pluginResult = await inspectPlugins({ ownerId, expiresAt: initialDrain.expiresAt.getTime() });
    if (pluginResult.backgroundWork === "unknown") return fail([unknownCode], "unknown");
    if (pluginResult.backgroundWork === "present") return fail([{ code: "plugins_busy" }]);
    if (pluginResult.backgroundWork !== "none" || !Array.isArray(pluginResult.pluginIds)
      || pluginResult.pluginIds.some(id => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
      return fail([unknownCode], "unknown");
    }

    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      // Gateway invocation rows are durable outcome records: a stranded
      // `executing` row can outlive its process and is not proof of live work.
      // Live Gateway promises are counted by the service boundary's local-work token.
      const unconfirmedPlugins = pluginResult.pluginIds.length === 0
        ? sql`EXISTS (SELECT 1 FROM plugins WHERE status <> 'disabled')`
        : sql`EXISTS (SELECT 1 FROM plugins WHERE status <> 'disabled'
            AND id NOT IN (${sql.join(pluginResult.pluginIds.map(id => sql`${id}::uuid`), sql`, `)}))`;
      return tx.execute<{ activeRuns: number; activeInvocations: number; activeOperations: number; unconfirmedPlugins: boolean }>(sql`
        SELECT
          (SELECT count(*)::int FROM heartbeat_runs WHERE status = 'running') AS "activeRuns",
          ((SELECT count(*) FROM decision_invocations WHERE status = 'running') +
           (SELECT count(*) FROM prompt_injection_invocations WHERE status = 'running'))::int AS "activeInvocations",
          ((SELECT count(*) FROM workspace_operations WHERE status = 'running') +
           (SELECT count(*) FROM environment_custom_image_setup_sessions
             WHERE status IN ('starting', 'waiting_for_user', 'capturing')))::int AS "activeOperations",
          ${unconfirmedPlugins} AS "unconfirmedPlugins"
      `);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    if (rows.length !== 1 || !Number.isSafeInteger(rows[0]?.activeRuns) || rows[0].activeRuns < 0
      || !Number.isSafeInteger(rows[0]?.activeInvocations) || rows[0].activeInvocations < 0
      || !Number.isSafeInteger(rows[0]?.activeOperations) || rows[0].activeOperations < 0
      || typeof rows[0]?.unconfirmedPlugins !== "boolean") return fail([unknownCode], "unknown");
    const dbBlockers: RestartReadinessBlocker[] = [];
    const activeDbEffects = rows[0].activeRuns + rows[0].activeInvocations + rows[0].activeOperations;
    if (activeDbEffects > 0) dbBlockers.push({ code: "database_effects_active", count: activeDbEffects });
    if (rows[0].unconfirmedPlugins) dbBlockers.push({ code: "plugins_busy" });
    if (dbBlockers.length) return fail(dbBlockers);

    const finalDrain = getDrainStatus();
    const finalSnapshot = idleWorkSnapshot();
    if (!sameDrain(initialDrain, finalDrain, ownerId) || finalDrain.activeRuns !== 0 || finalDrain.pendingWakes !== 0
      || initialSnapshot.generation !== finalSnapshot.generation || finalSnapshot.active !== 0
      || initialDrain.expiresAt.getTime() <= now()) {
      return fail([{ code: "generation_changed" }], "unknown");
    }
    return report(ownerId, "ready", initialDrain, initialSnapshot.generation, []);
  } catch {
    return fail([unknownCode], "unknown");
  }
}
