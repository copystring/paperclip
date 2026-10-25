import { describe, expect, it, vi } from "vitest";
import type { Db, heartbeatRuns } from "@paperclipai/db";
import { hasExplicitUserWake, isAutomaticManagerTriageRun, managerTriageWakeAllowed } from "./manager-triage-budget.js";

describe("manager triage admission scope", () => {
  const run = (context: Record<string, unknown> = {}) => ({ issueId: null, contextSnapshot: context }) as typeof heartbeatRuns.$inferSelect;
  function guardedDatabase() {
    const access = vi.fn(() => { throw new Error("Unbound history must not query issue UUIDs"); });
    return { db: new Proxy({}, { get: access }) as Db, access };
  }

  it.each([{}, { issueId: "AIW-23" }, { issueId: "not-a-uuid" }])("does not promote an unbound legacy label to an issue query: %j", async context => {
    const f = guardedDatabase();
    expect(await isAutomaticManagerTriageRun(f.db, run(context))).toBe(false);
    expect(await hasExplicitUserWake(f.db, run(context))).toBe(false);
    expect(f.access).not.toHaveBeenCalled();
  });

  it("fails closed for an unbound triage marker and invalid retry provenance", async () => {
    const f = guardedDatabase();
    expect(await isAutomaticManagerTriageRun(f.db, run({ managerTriageActionId: "marker" }))).toBe(true);
    expect(await managerTriageWakeAllowed(f.db, { companyId: "company", issueId: "issue", agentId: "agent",
      context: { retryOfRunId: "old-label" } })).toBe(false);
    expect(f.access).not.toHaveBeenCalled();
  });
});
