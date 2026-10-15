import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, documents, heartbeatRunEvents, heartbeatRuns, issueComments, issueDocuments, issues, issueThreadInteractions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { buildNativeSessionHandoff, createNativeSessionHandoffLoader, NATIVE_HANDOFF_MAX_BYTES, renderNativeSessionHandoff } from "./native-session-handoff.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { buildNativeModelEnvelope } from "@paperclipai/paperclip-runner";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

describe("bounded fresh-session handoff", () => {
  it("marks omissions and stays within its byte budget for huge Unicode histories", () => {
    const rendered = renderNativeSessionHandoff({ issueId: "task", generation: 1, omittedEntriesAtLeast: 1,
      entries: Array.from({ length: 100 }, (_, i) => ({ kind: "message", id: String(i), body: "🦖".repeat(10_000) })),
    });
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(NATIVE_HANDOFF_MAX_BYTES);
    expect(rendered).toContain('"truncated":true');
    expect(rendered).toContain("content omitted");
    expect(rendered).toContain("get_task_history");
    expect(rendered).toContain("Legacy adapters can use the equivalent Paperclip");
  });

  it("restores the handoff on fresh bootstrap and resume failure, without replaying it on resume", () => {
    const input = buildNativeExecutionInput({
      companyId: "company", runId: "run", agentId: "agent", normalizedSessionId: "session", conversationMode: true,
      issue: { id: "task", identifier: "BOT-2", title: "Chat", description: null, workMode: "standard" },
      taskPrompt: "GitHub is connected", freshSessionHandoff: "original goal: build the PR review bot", initialCommunicationGuidance: "Lead with the answer",
      workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1", contract: {
        revision: "1", objective: "Build bot", criteria: [{ id: "objective", requirement: "Build bot" }],
      } }, runtimeContext: nativeRuntimeContextFixture(),
    });
    expect(buildNativeModelEnvelope(input).task.prompt).toContain("original goal");
    const resumed = buildNativeModelEnvelope(input, { resumedSession: true });
    expect("task" in resumed && resumed.task.prompt).not.toContain("original goal");
    // The runtime uses the same full envelope if actual recovery fails.
    expect(buildNativeModelEnvelope(input).task.prompt).toContain("Lead with the answer");
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("handoff history scope", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), boundaryId = randomUUID(), requestId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-native-handoff-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Handoff", issuePrefix: "HAND" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Dickens", role: "general", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: "user", conversationState: "active", conversationSessionGeneration: 2 });
    await db.insert(issueComments).values([
      { companyId, issueId, body: "OLD TOPIC", authorUserId: "user", createdAt: new Date(1_000) },
      { id: boundaryId, companyId, issueId, body: "/new", authorUserId: "user", createdAt: new Date(2_000) },
      { id: requestId, companyId, issueId, body: "Build a GitHub PR review bot\n" + "x".repeat(6_000) + "\nFinal constraint: require a team review", authorUserId: "user", createdAt: new Date(3_000) },
      { companyId, issueId, body: "Deleted private message", authorUserId: "user", createdAt: new Date(4_000), deletedAt: new Date(5_000) },
      { companyId, issueId, body: "UNTRUSTED BODY", authorAgentId: agentId, createdAt: new Date(5_000),
        sourceTrust: { preset: "low_trust_review", disposition: "quarantined", sourceIssueId: issueId } },
      { companyId, issueId, body: "FUTURE MESSAGE", authorUserId: "user", createdAt: new Date(30_000) },
      { companyId, issueId, body: "I’ll check the review request.", authorAgentId: agentId, origin: "fast_response", createdAt: new Date(4_500) },
    ]);
    const { eq } = await import("drizzle-orm");
    await db.update(issues).set({ conversationBoundaryCommentId: boundaryId }).where(eq(issues.id, issueId));
    await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions", status: "answered",
      createdByAgentId: agentId, createdAt: new Date(6_000), resolvedAt: new Date(7_000),
      payload: { version: 1, questions: [] }, result: { version: 1, summaryMarkdown: "Use CODEOWNERS and publish a Storybook per PR" },
    });
    // An activity can start before the wake while its answer arrives later.
    // The answer timestamp, not just the activity's start, fences replay.
    await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions", status: "answered",
      createdByAgentId: agentId, createdAt: new Date(2_500), resolvedAt: new Date(3_500),
      payload: { version: 1, questions: [] }, result: { version: 1, summaryMarkdown: "LATER CUTOFF DECISION" },
    });
    const laterAnswerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: laterAnswerRunId, companyId, agentId, invocationSource: "automation", triggerDetail: "system", status: "succeeded",
      nativeIssueId: issueId, contextSnapshot: { issueId, conversationSessionGeneration: 2 }, createdAt: new Date(2_500), finishedAt: new Date(3_600),
      runnerProfileJson: { sessionCheckpoint: { semanticResult: { summary: "LATER CUTOFF RUN SUMMARY" } } } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: laterAnswerRunId, seq: 1, eventType: "item.completed", createdAt: new Date(3_500),
      payload: { prpEvent: { payload: { kind: "agentMessage", channel: "final", text: "LATER CUTOFF REPLY" } } } });
    const runId = randomUUID(), documentId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "automation", triggerDetail: "system", status: "succeeded",
      nativeIssueId: issueId, contextSnapshot: { issueId, conversationSessionGeneration: 2 }, createdAt: new Date(8_000), finishedAt: new Date(9_500),
      runnerProfileJson: { sessionCheckpoint: { semanticResult: { summary: "Waiting for GitHub access before configuring PR checks" } } } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 1, eventType: "item.completed", createdAt: new Date(9_000),
      payload: { prpEvent: { payload: { kind: "agentMessage", channel: "final", text: "Repository research complete; next configure PR checks" } } } });
    await db.insert(documents).values({ id: documentId, companyId, latestBody: "Saved plan: review changed files by CODEOWNERS", updatedAt: new Date(10_000) });
    await db.insert(issueDocuments).values({ companyId, issueId, documentId, key: "plan", createdAt: new Date(10_000) });
    await db.insert(heartbeatRuns).values([
      { companyId, agentId, status: "succeeded", runtimeMode: "legacy", contextSnapshot: { issueId, conversationSessionGeneration: 2 },
        resultJson: { summary: "Legacy answer: repository selection is complete" }, createdAt: new Date(12_000), finishedAt: new Date(13_000) },
      { companyId, agentId, status: "succeeded", runtimeMode: "legacy", contextSnapshot: { issueId: randomUUID(), conversationSessionGeneration: 2 },
        resultJson: { summary: "UNRELATED TASK ANSWER" }, createdAt: new Date(14_000), finishedAt: new Date(15_000) },
    ]);
  });
  afterAll(async () => database?.cleanup());
  it("preserves the original goal and prior answer while excluding reset, deleted and future history", async () => {
    const result = await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000) });
    expect(result).toContain("Build a GitHub PR review bot");
    expect(result).toContain('"author":"paperclip_receipt"');
    expect(result).toContain("[Paperclip acknowledgement; not agent work] I’ll check the review request.");
    expect(result).toContain("Final constraint: require a team review");
    expect(result).toContain('"truncated":true');
    expect(Buffer.byteLength(result!)).toBeLessThanOrEqual(NATIVE_HANDOFF_MAX_BYTES);
    expect(result).toContain("CODEOWNERS");
    expect(result).toContain("Repository research complete");
    expect(result).toContain("Saved plan");
    expect(result).toContain("Waiting for GitHub access");
    expect(result).toContain("Legacy answer: repository selection is complete");
    expect(result).not.toContain("UNRELATED TASK ANSWER");
    expect(result).not.toContain("OLD TOPIC");
    expect(result).not.toContain("Deleted private message");
    expect(result).not.toContain("FUTURE MESSAGE");
    expect(result).not.toContain("UNTRUSTED BODY");
    expect(result).not.toContain("/new");
    expect(await buildNativeSessionHandoff({ db, companyId: randomUUID(), issueId, agentId, before: new Date(20_000) })).toBeNull();
    expect(await buildNativeSessionHandoff({ db, companyId, issueId, agentId: randomUUID(), before: new Date(20_000) })).toBeNull();
  });
  it("honors the exact wake-comment cutoff when building a fresh replay", async () => {
    const result = await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000), throughCommentId: requestId });
    expect(result).toContain("Build a GitHub PR review bot");
    expect(result).not.toContain("CODEOWNERS");
    expect(result).not.toContain("Legacy answer");
    expect(result).not.toContain("LATER CUTOFF DECISION");
    expect(result).not.toContain("LATER CUTOFF REPLY");
    expect(result).not.toContain("LATER CUTOFF RUN SUMMARY");
    expect(await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000), throughCommentId: randomUUID() })).toBeNull();
  });

  it("loads and redacts history once only when a fresh attempt requests it", async () => {
    const select = vi.spyOn(db, "select");
    try {
      const load = createNativeSessionHandoffLoader({ db, companyId, issueId, agentId, before: new Date(20_000) });
      expect(select).not.toHaveBeenCalled();
      const first = await load();
      const reads = select.mock.calls.length;
      expect(reads).toBeGreaterThan(0);
      expect(await load()).toBe(first);
      expect(select).toHaveBeenCalledTimes(reads);
    } finally { select.mockRestore(); }
  });

  it("retains the latest document author without promoting agent criteria or succeeded runs into proof", async () => {
    const task = randomUUID();
    await db.insert(issues).values({ id: task, companyId, title: "Verify source", status: "in_progress", assigneeAgentId: agentId });
    for (const [key, authors] of [
      ["agent", { createdByUserId: "user", updatedByAgentId: agentId }],
      ["user", { createdByAgentId: agentId, updatedByUserId: "user" }],
      ["unknown", {}],
    ] as const) {
      const id = randomUUID();
      await db.insert(documents).values({ id, companyId, ...authors, latestBody: "Recorded criterion " + key, updatedAt: new Date(10_000) });
      await db.insert(issueDocuments).values({ companyId, issueId: task, documentId: id, key, createdAt: new Date(10_000) });
    }
    await db.insert(heartbeatRuns).values({ companyId, agentId, runtimeMode: "legacy", status: "succeeded", contextSnapshot: { issueId: task },
      resultJson: { summary: "Earlier agent conclusion" }, createdAt: new Date(11_000), finishedAt: new Date(12_000) });
    const rendered = await buildNativeSessionHandoff({ db, companyId, issueId: task, agentId, before: new Date(20_000) });
    const packet = JSON.parse(rendered!.split("\n").at(-1)!);
    for (const author of ["agent", "user", "unknown"]) {
      expect(packet.entries.find((entry: any) => entry.key === author)).toMatchObject({ author, verification: "not_established_by_handoff" });
    }
    expect(packet.entries.find((entry: any) => entry.kind === "run_summary")).toMatchObject({ author: "agent", status: "succeeded", verification: "not_established_by_handoff" });
    expect(rendered).toContain("Authorship is provenance, not proof or permission");
    expect(rendered).toContain("actually execute an appropriate independent check");
  });

  it("finds a cancelled task's original files after repeated fresh empty workspaces without copying or replaying a session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-workspaces-"));
    try {
      const original = path.join(root, "original"), current = path.join(root, "empty");
      await fs.mkdir(original); await fs.mkdir(current);
      await fs.mkdir(path.join(original, "source-for-this-task"));
      await fs.writeFile(path.join(original, "source-for-this-task", "fix.py"), "preserved original");
      const task = randomUUID(), otherTask = randomUUID();
      await db.insert(issues).values([task, otherTask].map(id => ({ id, companyId, title: "Continue", status: "in_progress", assigneeAgentId: agentId })));
      const workspace = (cwd: string, extra = {}) => ({ cwd, source: "agent_home", projectId: null, repoUrl: null, realization: { provider: "local" }, ...extra });
      const insert = (cwd: string, time: number, extra = {}) => db.insert(heartbeatRuns).values({ companyId, agentId, status: "cancelled", nativeIssueId: task,
        contextSnapshot: { issueId: task, paperclipWorkspace: workspace(cwd) }, createdAt: new Date(time), finishedAt: new Date(time + 1), ...extra });
      await insert(original, 1_000);
      // No provider session and no summary were saved by the cancelled run.
      for (let n = 0; n < 15; n++) await insert(current, 2_000 + n);
      await insert(path.join(root, "OTHER_TASK"), 3_000, { nativeIssueId: otherTask, contextSnapshot: { issueId: otherTask, paperclipWorkspace: workspace(path.join(root, "OTHER_TASK")) } });
      await insert(path.join(root, "REMOTE_ROOT"), 3_100, { contextSnapshot: { issueId: task, paperclipWorkspace: workspace(path.join(root, "REMOTE_ROOT"), { realization: { provider: "remote" } }) } });
      await insert(path.join(root, "PRIVATE_PROJECT"), 3_200, { contextSnapshot: { issueId: task, paperclipWorkspace: workspace(path.join(root, "PRIVATE_PROJECT"), { projectId: randomUUID() }) } });
      await insert(path.join(root, "QUARANTINED_ROOT"), 3_300, { contextSnapshot: { issueId: task, paperclipWorkspace: workspace(path.join(root, "QUARANTINED_ROOT")), executionPolicy: {
        trustPreset: "low_trust_review", authorizationPolicy: { trustPreset: "low_trust_review", trustBoundary: { mode: "low_trust_review", companyId, issueIds: [task] } },
      } } });
      const rendered = await buildNativeSessionHandoff({ db, companyId, issueId: task, agentId, before: new Date(10_000) });
      const packet = JSON.parse(rendered!.split("\n").at(-1)!);
      const refs = packet.entries.filter((e: any) => e.kind === "prior_workspace").map((e: any) => JSON.parse(e.body));
      expect(refs).toHaveLength(2);
      expect(refs).toContainEqual({ cwd: original, availability: "not_checked" });
      expect(rendered).not.toContain("OTHER_TASK"); expect(rendered).not.toContain("REMOTE_ROOT");
      expect(rendered).not.toContain("PRIVATE_PROJECT"); expect(rendered).not.toContain("QUARANTINED_ROOT");
      expect(await fs.readdir(current)).toEqual([]);
      expect(await fs.readFile(path.join(original, "source-for-this-task", "fix.py"), "utf8")).toBe("preserved original");
      expect(Buffer.byteLength(rendered!)).toBeLessThanOrEqual(NATIVE_HANDOFF_MAX_BYTES);
      const before = await buildNativeSessionHandoff({ db, companyId, issueId: task, agentId, before: new Date(500) });
      expect(before).toBeNull();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("fences workspace recovery by owner, conversation reset, generation and exact wake cutoff", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-fences-"));
    try {
      const task = randomUUID(), boundary = randomUUID(), cutoff = randomUUID(), otherAgent = randomUUID();
      await db.insert(agents).values({ id: otherAgent, companyId, name: "Other", role: "general", adapterType: "opencode_local" });
      await db.insert(issues).values({ id: task, companyId, title: "Reset task", status: "in_progress", assigneeAgentId: agentId,
        conversationAgentId: agentId, conversationUserId: "workspace-fences-user", conversationState: "active", conversationSessionGeneration: 2 });
      await db.insert(issueComments).values([
        { id: boundary, issueId: task, companyId, body: "/new", authorUserId: "user", createdAt: new Date(2_000) },
        { id: cutoff, issueId: task, companyId, body: "Continue", authorUserId: "user", createdAt: new Date(4_000) },
      ]);
      const { eq } = await import("drizzle-orm");
      await db.update(issues).set({ conversationBoundaryCommentId: boundary }).where(eq(issues.id, task));
      for (const [name, time, generation, owner, finished] of [
        ["OLD_BOUNDARY", 1_000, 2, agentId, 1_001], ["OLD_GENERATION", 3_000, 1, agentId, 3_001],
        ["OTHER_AGENT", 3_000, 2, otherAgent, 3_001], ["AFTER_CUTOFF", 4_500, 2, agentId, 4_501],
        ["UNFINISHED_AT_CUTOFF", 3_500, 2, agentId, 4_500], ["CURRENT", 3_000, 2, agentId, 3_001],
      ] as const) {
        const cwd = path.join(root, name); await fs.mkdir(cwd);
        await db.insert(heartbeatRuns).values({ companyId, agentId: owner, status: "cancelled", nativeIssueId: task,
          contextSnapshot: { issueId: task, conversationSessionGeneration: generation,
            paperclipWorkspace: { cwd, source: "agent_home", realization: { provider: "local" } } },
          createdAt: new Date(time), finishedAt: new Date(finished) });
      }
      const rendered = await buildNativeSessionHandoff({ db, companyId, issueId: task, agentId, before: new Date(10_000), throughCommentId: cutoff });
      const refs = JSON.parse(rendered!.split("\n").at(-1)!).entries.filter((e: any) => e.kind === "prior_workspace");
      expect(refs).toHaveLength(1);
      expect(JSON.parse(refs[0].body).cwd).toBe(path.join(root, "CURRENT"));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("selects recent distinct locations before the output limit and never reads symlink targets or filenames", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-reference-only-"));
    try {
      const task = randomUUID(), linkedTask = randomUUID();
      await db.insert(issues).values([task, linkedTask].map(id => ({ id, companyId, title: "References", status: "in_progress", assigneeAgentId: agentId })));
      for (const [index, name] of ["a-oldest", "b-second", "c-third", "d-fourth", "z-newest", "a-quarantined"].entries()) {
        await db.insert(heartbeatRuns).values({ companyId, agentId, status: "cancelled", nativeIssueId: task,
          contextSnapshot: { issueId: task, paperclipWorkspace: { cwd: path.join(root, name), source: "agent_home", realization: { provider: "local" } },
            ...(index === 5 ? { executionPolicy: { trustPreset: "low_trust_review", authorizationPolicy: { trustPreset: "low_trust_review", trustBoundary: { mode: "low_trust_review", companyId, issueIds: [task] } } } } : {}) },
          createdAt: new Date(1_000 + index), finishedAt: new Date(2_000 + index) });
      }
      const rendered = await buildNativeSessionHandoff({ db, companyId, issueId: task, agentId, before: new Date(10_000) });
      const refs = JSON.parse(rendered!.split("\n").at(-1)!).entries.filter((e: any) => e.kind === "prior_workspace").map((e: any) => JSON.parse(e.body).cwd);
      expect(refs).toEqual(["z-newest", "d-fourth", "c-third", "b-second"].map(name => path.join(root, name)));
      expect(rendered).not.toContain("a-oldest"); expect(rendered).not.toContain("a-quarantined");
      expect(JSON.parse(rendered!.split("\n").at(-1)!).omittedEntriesAtLeast).toBeGreaterThanOrEqual(1);
      const target = path.join(root, "private"), alias = path.join(root, "alias");
      await fs.mkdir(path.join(target, "sub"), { recursive: true });
      await fs.writeFile(path.join(target, "sub", "SECRET_DIRECTORY_ENTRY"), "SECRET_FILE_CONTENT");
      await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
      await db.insert(heartbeatRuns).values({ companyId, agentId, status: "cancelled", nativeIssueId: linkedTask,
        contextSnapshot: { issueId: linkedTask, paperclipWorkspace: { cwd: path.join(alias, "sub"), source: "agent_home", realization: { provider: "local" } } },
        createdAt: new Date(1_000), finishedAt: new Date(2_000) });
      const list = vi.spyOn(fs, "opendir"), stat = vi.spyOn(fs, "lstat");
      try {
        const linked = await buildNativeSessionHandoff({ db, companyId, issueId: linkedTask, agentId, before: new Date(10_000) });
        const ref = JSON.parse(linked!.split("\n").at(-1)!).entries.find((e: any) => e.kind === "prior_workspace");
        expect(JSON.parse(ref.body).availability).toBe("not_checked");
        expect(linked).not.toContain("SECRET_DIRECTORY_ENTRY"); expect(linked).not.toContain("SECRET_FILE_CONTENT");
        expect(list).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled();
      } finally { list.mockRestore(); stat.mockRestore(); }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("retains a prior run's quarantine after the current agent and task use standard policy", async () => {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", nativeIssueId: issueId,
      contextSnapshot: { issueId, conversationSessionGeneration: 2, executionPolicy: {
        trustPreset: "low_trust_review", authorizationPolicy: { trustPreset: "low_trust_review",
          trustBoundary: { mode: "low_trust_review", companyId, issueIds: [issueId] } },
      } }, createdAt: new Date(16_000), finishedAt: new Date(18_000),
      runnerProfileJson: { sessionCheckpoint: { semanticResult: { summary: "QUARANTINED RUN SUMMARY" } } } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 1, eventType: "item.completed", createdAt: new Date(17_000),
      payload: { prpEvent: { payload: { kind: "agentMessage", channel: "final", text: "QUARANTINED RUN REPLY" } } } });
    const result = await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000) });
    expect(result).not.toContain("QUARANTINED RUN REPLY");
    expect(result).not.toContain("QUARANTINED RUN SUMMARY");
    expect(result).toContain("Quarantined low-trust output omitted");
    expect(result).toContain(runId);
  });
});
