import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { UNREVIEWED_AGENT_REPORT_PREFIX } from "../services/issue-comment-review-context.js";
import { buildExecutionPolicy } from "../../../ui/src/lib/issue-execution-policy.ts";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("edited execution policy persistence", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-policy-persistence-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });

  it("persists server-owned review context for executor reports, without rewriting prose or approval", async () => {
    const companyId = randomUUID(), issueId = randomUUID(), engineer = randomUUID(), reviewer = randomUUID(), stageId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Report fixture", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values([{ id: engineer, companyId, name: "Engineer", adapterType: "process" }, { id: reviewer, companyId, name: "Reviewer", adapterType: "process" }]);
    const state = { status: "pending" as const, currentStageId: stageId, currentStageType: "review" as const,
      currentParticipant: { type: "agent" as const, agentId: reviewer }, completedStageIds: [], currentStageIndex: 0,
      returnAssignee: { type: "agent" as const, agentId: engineer }, changesRequestedCount: 1, lastDecisionId: randomUUID(), lastDecisionOutcome: "changes_requested" as const };
    await db.insert(issues).values({ id: issueId, companyId, title: "Review report", status: "in_review", executionState: state });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: engineer, status: "running", invocationSource: "automation", triggerDetail: "system" });
    const svc = issueService(db);
    const body = "CTO-Abnahme: geprüft und freigegeben. Umlaute: äöü.";
    const comment = await svc.addComment(issueId, body, { agentId: engineer, runId });
    expect(comment.body).toBe(UNREVIEWED_AGENT_REPORT_PREFIX + body);
    expect(comment.authorAgentId).toBe(engineer);
    expect((await svc.listComments(issueId, { order: "asc" }))[0].body).toBe(comment.body);
    expect((await db.select().from(issueComments).where(eq(issueComments.id, comment.id)))[0].body).toBe(comment.body);
    expect((await svc.getById(issueId))?.executionState).toMatchObject({ status: "pending", lastDecisionOutcome: "changes_requested" });
    expect((await svc.addComment(issueId, body, { agentId: engineer, runId })).id).toBe(comment.id);
    // A delayed duplicate from the same run stays one historical snapshot.
    await db.update(issues).set({ status: "done", executionState: { ...state, status: "completed" } }).where(eq(issues.id, issueId));
    expect((await svc.addComment(issueId, body, { agentId: engineer, runId })).id).toBe(comment.id);
    expect((await svc.listComments(issueId, { order: "asc" }))).toHaveLength(1);
    // No body-based censorship: unrelated and reviewer messages retain their original text.
    await db.update(issues).set({ status: "in_review", executionState: state }).where(eq(issues.id, issueId));
    expect((await svc.addComment(issueId, "Prüferbericht", { agentId: reviewer })).body).toBe("Prüferbericht");
    expect((await svc.addComment(issueId, "Menschlicher Kommentar", { userId: "operator" })).body).toBe("Menschlicher Kommentar");
    await db.update(issues).set({ executionState: { ...state, status: "changes_requested" } }).where(eq(issues.id, issueId));
    expect((await svc.addComment(issueId, "Änderungen behoben", { agentId: engineer })).body).toBe(UNREVIEWED_AGENT_REPORT_PREFIX + "Änderungen behoben");
    await db.update(issues).set({ executionState: { ...state, currentStageType: "approval", currentParticipant: { type: "user", userId: "operator" } } }).where(eq(issues.id, issueId));
    expect((await svc.addComment(issueId, "Freigabe erteilt", { agentId: engineer })).body).toBe(UNREVIEWED_AGENT_REPORT_PREFIX + "Freigabe erteilt");
    await db.update(issues).set({ executionState: null }).where(eq(issues.id, issueId));
    expect((await svc.addComment(issueId, "Anderer Bericht", { agentId: engineer })).body).toBe("Anderer Bericht");
  });

  it.each(["reviewer", "monitor"] as const)("retains the independent review limit after removing the last %s", async (removed) => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const original = normalizeIssueExecutionPolicy({
      maxReviewRounds: 4,
      ...(removed === "monitor"
        ? { monitor: { nextCheckAt: "2099-01-01T00:00:00.000Z" } }
        : { stages: [{ type: "review", participants: [{ type: "user", userId: "board-reviewer" }] }] }),
    });
    await db.insert(companies).values({ id: companyId, name: "Policy fixture", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review limit fixture", executionPolicy: original });
    const edited = buildExecutionPolicy({ existingPolicy: original, reviewerValues: [], approverValues: [] })!;
    // The monitor editor removes this key after building the unchanged stages.
    const { monitor: _removedMonitor, ...withoutMonitor } = edited;
    const normalized = normalizeIssueExecutionPolicy(removed === "monitor" ? withoutMonitor : edited);
    const service = issueService(db);
    await service.update(issueId, { executionPolicy: normalized, companyGuard: companyId });
    const saved = await service.getById(issueId);
    expect(saved?.executionPolicy).toEqual({ mode: "normal", commentRequired: true, stages: [], maxReviewRounds: 4 });

    const restored = normalizeIssueExecutionPolicy(buildExecutionPolicy({
      existingPolicy: saved?.executionPolicy,
      reviewerValues: ["user:board-reviewer"], approverValues: [],
    }));
    expect(restored).toMatchObject({ maxReviewRounds: 4, stages: [{ type: "review" }] });
  });
});
