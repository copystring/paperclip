import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HELPER_PATH = fileURLToPath(new URL("../../../skills/paperclip/scripts/paperclip-read-documents.mjs", import.meta.url));

interface ServerRequest { method: string; url: string; authorization?: string; runId?: string | string[] }
interface HelperResult { code: number | null; stdout: string; stderr: string }

describe("paperclip read documents helper", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!().catch(() => undefined);
  });

  async function startServer(respond: (request: ServerRequest, res: http.ServerResponse) => void) {
    const requests: ServerRequest[] = [];
    const server = http.createServer((req, res) => {
      const request = { method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, runId: req.headers["x-paperclip-run-id"] };
      requests.push(request);
      respond(request, res);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const port = (server.address() as AddressInfo).port;
    return { baseUrl: `http://127.0.0.1:${port}`, requests };
  }

  function runHelper(apiUrl: string, args: string[], cwd: string, helper = HELPER_PATH): Promise<HelperResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [helper, ...args], {
        cwd,
        env: { ...process.env, PAPERCLIP_API_URL: apiUrl, PAPERCLIP_API_KEY: "fixture-key", PAPERCLIP_RUN_ID: "fixture-run" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", code => resolve({ code, stdout, stderr }));
    });
  }

  async function createCwd() {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-read-docs-"));
    cleanup.push(() => fs.rm(cwd, { recursive: true, force: true }));
    return cwd;
  }

  function response(reference: string, body: string) {
    const separator = reference.lastIndexOf("/");
    return {
      id: `doc-${reference}`,
      companyId: "company-fixture",
      issueId: reference.slice(0, separator),
      key: reference.slice(separator + 1),
      title: `Document ${reference}`,
      format: "markdown",
      body,
      latestRevisionId: `revision-${reference}`,
      latestRevisionNumber: 3,
      sourceTrust: null,
    };
  }

  it("fetches explicit documents in parallel, writes private Unicode-safe complete segments, and prints only a revision manifest", async () => {
    const longBody = `${"a".repeat(5999)}🌒${"界é".repeat(5000)}\nlast line`;
    const issueIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    let active = 0;
    let maximumActive = 0;
    const { baseUrl, requests } = await startServer((request, res) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const url = new URL(request.url, baseUrl);
      const [, , , issueId, , key] = url.pathname.split("/");
      setTimeout(() => {
        active -= 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response(`${issueId}/${key}`, key === "policy" ? longBody : "Lessons ✅\nsecond line")));
      }, 10);
    });
    const cwd = await createCwd();
    const args = issueIds.flatMap(issueId => ["--document", `${issueId}/policy`, "--document", `${issueId}/lessons`]);

    const result = await runHelper(baseUrl, args, cwd);

    expect(result.code).toBe(0);
    const manifest = JSON.parse(result.stdout) as { outputRoot: string; documents: Array<{ issueId: string; key: string; latestRevisionId: string; latestRevisionNumber: number; bodyBytes: number; bodySha256: string; segments: Array<{ path: string; characters: number }> }> };
    expect(manifest.documents).toHaveLength(6);
    expect(path.isAbsolute(manifest.outputRoot)).toBe(true);
    for (const document of manifest.documents) {
      for (const segment of document.segments) {
        // Consumers such as file-read tools may resolve relative paths from a
        // different root. The manifest must be directly usable without
        // reconstructing an opaque task/workspace prefix.
        expect(path.isAbsolute(segment.path)).toBe(true);
        expect(path.relative(manifest.outputRoot, segment.path)).not.toMatch(/^\.\.(?:[\\/]|$)/);
        await expect(fs.access(segment.path)).resolves.toBeUndefined();
      }
    }
    expect(requests).toHaveLength(6);
    expect(requests.every(request => request.method === "GET" && request.authorization === "Bearer fixture-key" && request.runId === "fixture-run")).toBe(true);
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(4);
    const policy = manifest.documents.find(document => document.issueId === issueIds[0] && document.key === "policy")!;
    expect(policy.latestRevisionId).toBe(`revision-${issueIds[0]}/policy`);
    expect(policy.latestRevisionNumber).toBe(3);
    expect(policy.bodyBytes).toBe(Buffer.byteLength(longBody));
    expect(policy.bodySha256).toBe((await import("node:crypto")).createHash("sha256").update(longBody).digest("hex"));
    const segments = await Promise.all(policy.segments.map(segment => fs.readFile(segment.path, "utf8")));
    expect(segments.join("")).toBe(longBody);
    expect(policy.segments.every((segment, index) => segment.characters <= 6000 && (index === 0 || segment.characters > 0))).toBe(true);
    expect(result.stdout).not.toContain(longBody);
    expect(result.stdout).toContain(JSON.stringify(manifest.outputRoot));
    if (process.platform !== "win32") {
      const rootStat = await fs.stat(manifest.outputRoot);
      const firstSegment = await fs.stat(policy.segments[0]!.path);
      expect(rootStat.mode & 0o777).toBe(0o700);
      expect(firstSegment.mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    ["HTTP 401", (_request: ServerRequest, res: http.ServerResponse) => { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); }, "HTTP 401"],
    ["malformed JSON", (_request: ServerRequest, res: http.ServerResponse) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{"); }, "malformed JSON"],
    ["missing revision", (_request: ServerRequest, res: http.ServerResponse) => { res.writeHead(200, { "content-type": "application/json" }); const doc = response("11111111-1111-4111-8111-111111111111/policy", "body"); delete (doc as Partial<typeof doc>).latestRevisionId; res.end(JSON.stringify(doc)); }, "complete body and revision"],
    ["missing body", (_request: ServerRequest, res: http.ServerResponse) => { res.writeHead(200, { "content-type": "application/json" }); const doc = response("11111111-1111-4111-8111-111111111111/policy", "body"); delete (doc as Partial<typeof doc>).body; res.end(JSON.stringify(doc)); }, "complete body and revision"],
    ["wrong issue/key", (_request: ServerRequest, res: http.ServerResponse) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(response("22222222-2222-4222-8222-222222222222/other", "body"))); }, "complete body and revision"],
    ["redirect", (_request: ServerRequest, res: http.ServerResponse) => { res.writeHead(302, { location: "/elsewhere" }); res.end(); }, "HTTP 302"],
  ])("does not create a success manifest after %s", async (_name, responder, expected) => {
    const { baseUrl, requests } = await startServer(responder as (request: ServerRequest, res: http.ServerResponse) => void);
    const cwd = await createCwd();
    const result = await runHelper(baseUrl, ["--document", "11111111-1111-4111-8111-111111111111/policy", "--document", "11111111-1111-4111-8111-111111111111/lessons"], cwd);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(expected as string);
    expect(requests).toHaveLength(2);
    expect(await fs.readdir(cwd)).toEqual([]);
  });

  it("rejects more than eight document references before making requests", async () => {
    const { baseUrl, requests } = await startServer((_request, res) => { res.writeHead(404); res.end(); });
    const cwd = await createCwd();
    const args = Array.from({ length: 9 }, (_, index) => ["--document", `TST-${index}/policy`]).flat();
    const result = await runHelper(baseUrl, args, cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("At most 8 documents");
    expect(requests).toHaveLength(0);
  });

  it("accepts an issue identifier while retaining the API's canonical UUID in the manifest", async () => {
    const issueId = "11111111-1111-4111-8111-111111111111";
    const { baseUrl, requests } = await startServer((_request, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response(`${issueId}/policy`, "policy body")));
    });
    const cwd = await createCwd();
    const result = await runHelper(baseUrl, ["--document", "TST-1/policy"], cwd);
    expect(result.code).toBe(0);
    expect(requests[0]?.url).toBe("/api/issues/TST-1/documents/policy");
    expect(JSON.parse(result.stdout).documents[0]).toMatchObject({ requestedIssueId: "TST-1", issueId, key: "policy" });
  });

  it("normalizes PAPERCLIP_API_URL when it already ends in /api", async () => {
    const issueId = "11111111-1111-4111-8111-111111111111";
    const { baseUrl, requests } = await startServer((_request, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response(`${issueId}/policy`, "policy body")));
    });
    const cwd = await createCwd();
    const result = await runHelper(`${baseUrl}/api`, ["--document", `${issueId}/policy`], cwd);
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`/api/issues/${issueId}/documents/policy`);
  });

  it("runs the real CLI through an installed skill-directory symlink", async () => {
    const issueId = "11111111-1111-4111-8111-111111111111";
    const { baseUrl, requests } = await startServer((_request, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response(`${issueId}/policy`, "policy body")));
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-read-docs-symlink-"));
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
    const cwd = path.join(root, "unrelated task workspace");
    const installedSkill = path.join(root, ".claude", "skills", "paperclip");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.dirname(installedSkill), { recursive: true });
    await fs.symlink(path.dirname(path.dirname(HELPER_PATH)), installedSkill, process.platform === "win32" ? "junction" : "dir");
    const linkedHelper = path.join(installedSkill, "scripts", "paperclip-read-documents.mjs");
    expect(await fs.realpath(linkedHelper)).toBe(await fs.realpath(HELPER_PATH));
    expect(path.resolve(linkedHelper)).not.toBe(await fs.realpath(linkedHelper));

    const result = await runHelper(baseUrl, ["--document", `${issueId}/policy`], cwd, linkedHelper);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).documents[0]).toMatchObject({ issueId, key: "policy", latestRevisionNumber: 3 });
    expect(requests).toHaveLength(1);
  });

  it("imports without CLI argv and produces no output or network request", async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(HELPER_PATH).href)})`], {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !["PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_RUN_ID"].includes(key))),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  it("fails closed on an oversized streamed HTTP response without writing files", async () => {
    const { baseUrl, requests } = await startServer((_request, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response("11111111-1111-4111-8111-111111111111/policy", "x".repeat(2 * 1024 * 1024 + 100))));
    });
    const cwd = await createCwd();
    const result = await runHelper(baseUrl, ["--document", "11111111-1111-4111-8111-111111111111/policy"], cwd);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("safety bound");
    expect(requests).toHaveLength(1);
    expect(await fs.readdir(cwd)).toEqual([]);
  });

  it("aborts in-flight fetches and never starts queued GETs after a batch failure", async () => {
    const { baseUrl, requests } = await startServer((request, res) => {
      if (request.url.endsWith("/policy")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json" });
        const issueId = request.url.split("/")[3];
        const key = request.url.split("/")[5];
        res.end(JSON.stringify(response(`${issueId}/${key}`, "body")));
      }, 300);
    });
    const cwd = await createCwd();
    const args = Array.from({ length: 5 }, (_, index) => ["--document", `11111111-1111-4111-8111-11111111111${index}/lessons`]).flat();
    args[1] = "11111111-1111-4111-8111-111111111111/policy";
    const result = await runHelper(baseUrl, args, cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("HTTP 401");
    expect(requests).toHaveLength(4);
    expect(requests.some(request => request.url.includes("11111111-1111-4111-8111-111111111114"))).toBe(false);
    expect(await fs.readdir(cwd)).toEqual([]);
  });

  it("does not publish a manifest or leave files when one document in a batch fails", async () => {
    const { baseUrl, requests } = await startServer((request, res) => {
      res.writeHead(request.url.endsWith("/policy") ? 200 : 404, { "content-type": "application/json" });
      res.end(request.url.endsWith("/policy")
        ? JSON.stringify(response("11111111-1111-4111-8111-111111111111/policy", "complete policy"))
        : JSON.stringify({ error: "not found" }));
    });
    const cwd = await createCwd();
    const result = await runHelper(baseUrl, [
      "--document", "11111111-1111-4111-8111-111111111111/policy",
      "--document", "11111111-1111-4111-8111-111111111111/lessons",
    ], cwd);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("HTTP 404");
    expect(requests).toHaveLength(2);
    expect(await fs.readdir(cwd)).toEqual([]);
  });
});
