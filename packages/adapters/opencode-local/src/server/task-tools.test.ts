import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PAPERCLIP_TASK_TOOLS_SOURCE } from "./task-tools.js";

const exec = promisify(execFile);
describe("prepared Paperclip task operations", () => {
  let root: string, file: string, base: string;
  let server: http.Server;
  let calls: Array<{ method: string; url: string; body: any }>;
  let current: any;
  let responseMode: string;
  const body = ("x".repeat(5999) + "🦖" + "ä\n".repeat(3500) + "x".repeat(9000) + "END");
  const at = "2099-01-01T00:00:00.000Z", timeout = "2099-01-01T00:10:00.000Z";
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-task-tools-test-"));
    file = path.join(root, "tools.mjs");
    await fs.writeFile(file, PAPERCLIP_TASK_TOOLS_SOURCE);
    calls = []; responseMode = "ok";
    current = { assigneeAgentId: "agent", assigneeUserId: null, status: "in_progress", monitorAttemptCount: 0,
      executionPolicy: { mode: "normal", stages: [{ type: "review", participants: ["reviewer"] }], authorizationPolicy: { trustPreset: "standard", keep: true } } };
    server = http.createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const data = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method!, url: req.url!, body: data });
      expect(req.headers.authorization).toBe("Bearer PRIVATE-TEST-TOKEN");
      expect(req.headers["x-paperclip-run-id"]).toBe("run");
      res.setHeader("content-type", "application/json");
      if (responseMode === "denied") { res.statusCode = 403; res.end('{"private":"PRIVATE-TEST-TOKEN"}'); return; }
      if (req.url!.includes("/documents/")) {
        res.end(JSON.stringify({ body, latestRevisionId: "revision-1" })); return;
      }
      if (req.method === "PATCH") {
        if (responseMode === "conflict") { res.statusCode = 409; res.end("{}"); return; }
        current.executionPolicy = data.executionPolicy;
        current.monitorNextCheckAt = data.executionPolicy.monitor.nextCheckAt;
        if (responseMode === "reordered") {
          current.executionPolicy = JSON.parse(JSON.stringify(current.executionPolicy, (_key, value) =>
            value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value));
        }
        if (responseMode === "defaults") current.executionPolicy = { mode: "normal", commentRequired: true, stages: [], ...current.executionPolicy };
        if (responseMode === "mismatch") current.executionPolicy.monitor.notes = "changed concurrently";
      }
      res.end(JSON.stringify(current));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = "http://127.0.0.1:" + (server.address() as { port: number }).port + "/api/";
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function run(args: string[]) {
    try {
      const out = await exec(process.execPath, [file, ...args], { env: { ...process.env, PAPERCLIP_API_URL: base,
        PAPERCLIP_API_KEY: "PRIVATE-TEST-TOKEN", PAPERCLIP_RUN_ID: "run", PAPERCLIP_TASK_ID: "task", PAPERCLIP_AGENT_ID: "agent" } });
      return { code: 0, out: JSON.parse(out.stdout), stderr: out.stderr };
    } catch (error: any) {
      return { code: error.code, out: error.stdout, stderr: error.stderr };
    }
  }
  const monitorArgs = () => ["set-monitor", "--at", at, "--timeout-at", timeout, "--notes", "Read the actual CI result", "--max-attempts", "2"];
  it("reads a complete immutable document snapshot through bounded pages, including overlong lines", async () => {
    let result = await run(["read-document", "--issue-id", "policy", "--key", "rules"]);
    expect(result.code).toBe(0); expect(result.out.complete).toBe(false); expect(result.out.revisionId).toBe("revision-1");
    const snapshot = result.out.file, digest = result.out.sha256;
    let combined = result.out.body;
    while (!result.out.complete) {
      result = await run(["read-snapshot", "--file", snapshot, "--sha256", digest, "--offset", String(result.out.nextOffset)]);
      expect(result.code).toBe(0); expect(result.out.body.length).toBeLessThanOrEqual(6000); combined += result.out.body;
    }
    expect(combined).toBe(body); expect(calls).toHaveLength(1);
    expect((await run(["read-snapshot", "--file", snapshot, "--sha256", digest, "--offset", "6000"])).code).not.toBe(0);
    await fs.writeFile(snapshot, "modified");
    expect((await run(["read-snapshot", "--file", snapshot, "--sha256", digest, "--offset", "0"])).code).not.toBe(0);
    expect((await run(["read-snapshot", "--file", file, "--sha256", digest, "--offset", "0"])).code).not.toBe(0);
  });
  it("uses one policy-only CAS and confirms the saved eligible monitor without rewriting review or status", async () => {
    const before = structuredClone(current);
    const result = await run(monitorArgs());
    expect(result.code).toBe(0); expect(result.out.confirmed).toBe(true);
    expect(calls.map(x => x.method)).toEqual(["GET", "PATCH", "GET"]);
    expect(calls[1].body.expectedExecutionPolicy).toEqual(before.executionPolicy);
    expect(Object.keys(calls[1].body)).toEqual(["expectedExecutionPolicy", "executionPolicy"]);
    expect(current.executionPolicy.stages).toEqual(before.executionPolicy.stages);
    expect(current.executionPolicy.authorizationPolicy).toEqual(before.executionPolicy.authorizationPolicy);
    expect(current.status).toBe(before.status);
    expect(result.stderr + JSON.stringify(result.out)).not.toContain("PRIVATE-TEST-TOKEN");
  });
  it("preserves tighter attempt, timeout and recovery policy limits", async () => {
    current.executionPolicy.monitor = { kind: "external_service", maxAttempts: 1, timeoutAt: "2099-01-01T00:05:00.000Z", recoveryPolicy: { allowRetry: false } };
    const result = await run(monitorArgs());
    expect(result.code).toBe(0); expect(current.executionPolicy.monitor.maxAttempts).toBe(1);
    expect(current.executionPolicy.monitor.timeoutAt).toBe("2099-01-01T00:05:00.000Z");
    expect(current.executionPolicy.monitor.recoveryPolicy).toEqual({ allowRetry: false });
  });
  it("confirms semantically equal policy and recovery objects with reordered keys", async () => {
    current.executionPolicy.monitor = { maxAttempts: 2, recoveryPolicy: { enabled: false, count: 1 } };
    responseMode = "reordered";
    expect((await run(monitorArgs())).out.confirmed).toBe(true);
  });
  it("accepts server defaults introduced when starting from a null execution policy", async () => {
    current.executionPolicy = null; responseMode = "defaults";
    const result = await run(monitorArgs());
    expect(result.code).toBe(0); expect(calls[1].body.expectedExecutionPolicy).toBeNull();
  });
  it("refuses unknown policy fields before the legacy API could strip them", async () => {
    current.executionPolicy.futureField = { keep: true };
    expect((await run(monitorArgs())).code).not.toBe(0);
    expect(calls.map(x => x.method)).toEqual(["GET"]);
  });
  it("retains consumed monitor bounds when the scheduler has removed its policy block", async () => {
    current.monitorAttemptCount = 1;
    current.executionState = { monitor: { status: "triggered", attemptCount: 1, maxAttempts: 2, timeoutAt: "2099-01-01T00:05:00.000Z", recoveryPolicy: { allowRetry: false } } };
    const result = await run(monitorArgs());
    expect(result.code).toBe(0); expect(result.out.timeoutAt).toBe("2099-01-01T00:05:00.000Z");
    expect(current.executionPolicy.monitor).not.toHaveProperty("status");
    expect(current.executionPolicy.monitor.recoveryPolicy).toEqual({ allowRetry: false });
    current.executionPolicy.monitor = undefined;
    current.monitorAttemptCount = 2; current.executionState.monitor.attemptCount = 2;
    const beforeCalls = calls.length;
    expect((await run([...monitorArgs().slice(0, -1), "3"])).code).not.toBe(0);
    expect(calls.slice(beforeCalls).map(x => x.method)).toEqual(["GET"]);
  });
  it.each(["blocked", "done", "foreign", "human", "budget", "timeout"])("does not write when eligibility or existing bounds reject %s", async mode => {
    if (["blocked", "done"].includes(mode)) current.status = mode;
    if (mode === "foreign") current.assigneeAgentId = "other";
    if (mode === "human") current.assigneeUserId = "human";
    if (mode === "budget") { current.monitorAttemptCount = 1; current.executionPolicy.monitor = { maxAttempts: 1 }; }
    if (mode === "timeout") current.executionPolicy.monitor = { timeoutAt: "2000-01-01T00:00:00Z" };
    expect((await run(monitorArgs())).code).not.toBe(0); expect(calls.map(x => x.method)).toEqual(["GET"]);
  });
  it.each(["conflict", "mismatch", "denied"])("does not retry or claim a monitor after %s", async mode => {
    responseMode = mode;
    const result = await run(monitorArgs());
    expect(result.code).not.toBe(0); expect(result.stderr).toContain('"confirmed":false');
    expect(result.stderr).not.toContain("PRIVATE-TEST-TOKEN");
    expect(calls.filter(x => x.method === "PATCH").length).toBeLessThanOrEqual(1);
  });
});
