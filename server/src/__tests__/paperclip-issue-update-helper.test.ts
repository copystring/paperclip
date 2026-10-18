import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import { ensurePaperclipSkillSymlink } from "@paperclipai/adapter-utils/server-utils";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const HELPER_PATH = path.resolve("skills/paperclip/scripts/paperclip-issue-update.sh");
const REPO_HELPER_PATH = path.resolve("scripts/paperclip-issue-update.sh");

interface HelperResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
  authorization: string | undefined;
  runId: string | string[] | undefined;
}

describe("paperclip issue update helper", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const cleanup = cleanupFns.pop();
      if (!cleanup) continue;
      await cleanup().catch(() => undefined);
    }
  });

  async function startServer(
    respond: (request: RecordedRequest, attempt: number, res: http.ServerResponse) => void,
  ): Promise<{ baseUrl: string; requests: RecordedRequest[] }> {
    const requests: RecordedRequest[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const recorded: RecordedRequest = {
          method: req.method ?? "",
          url: req.url ?? "",
          body,
          authorization: req.headers.authorization,
          runId: req.headers["x-paperclip-run-id"],
        };
        requests.push(recorded);
        respond(recorded, requests.length, res);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanupFns.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}`, requests };
  }

  function runHelper(apiUrl: string, args: string[], options: { helper?: string; cwd?: string; input?: string } = {}): Promise<HelperResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", [options.helper ?? HELPER_PATH, ...args], {
        cwd: options.cwd,
        env: {
          ...process.env,
          PAPERCLIP_API_URL: apiUrl,
          PAPERCLIP_API_KEY: "test-key",
          PAPERCLIP_RUN_ID: "test-run",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end(options.input);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  const comment = "Abgeschlossen\n\n- Status: bereit ✅\n- Mehrzeiliger Nachweis";
  const doneArgs = ["--issue-id", "issue-1", "--status", "done", "--comment", comment];

  it("combines status and an exact Unicode multiline comment in one confirmed PATCH", async () => {
    const { baseUrl, requests } = await startServer((request, _attempt, res) => {
      const payload = JSON.parse(request.body) as { status?: string; comment?: string };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "issue-1", status: payload.status, comment: { body: payload.comment } }));
    });

    const result = await runHelper(baseUrl, doneArgs);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: "issue-1", status: "done", comment: { body: comment } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.url).toBe("/api/issues/issue-1");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ status: "done", comment });
  });

  it("confirms an issue addressed by identifier when the response carries its UUID", async () => {
    const { baseUrl, requests } = await startServer((request, _attempt, res) => {
      const payload = JSON.parse(request.body) as { status?: string; comment?: string };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "f4c2ca29-1051-4d25-9da0-4e91748c2376", identifier: "TST-123", status: payload.status, comment: { body: payload.comment } }));
    });

    const result = await runHelper(baseUrl, ["--issue-id", "tst-123", "--status", "done", "--comment", comment]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ identifier: "TST-123", status: "done", comment: { body: comment } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/api/issues/tst-123");
  });

  it.each([".claude/skills", "codex-home/skills"])(
    "delivers the bundled helper through %s from an unrelated workspace", async skillsHome => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip completion helper "));
      cleanupFns.push(() => fs.rm(root, { recursive: true, force: true }));
      const source = path.join(root, "bundle", "paperclip");
      const installed = path.join(root, skillsHome, "paperclip");
      const cwd = path.join(root, "unrelated project");
      await fs.cp(path.dirname(path.dirname(HELPER_PATH)), source, { recursive: true });
      await fs.mkdir(path.dirname(installed), { recursive: true });
      await fs.mkdir(cwd);
      await ensurePaperclipSkillSymlink(source, installed);
      await expect(fs.access(path.join(cwd, "scripts/paperclip-issue-update.sh"))).rejects.toThrow();
      const savedComments: string[] = [];
      const { baseUrl, requests } = await startServer((request, _attempt, res) => {
        const payload = JSON.parse(request.body);
        savedComments.push(payload.comment);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "issue-1", status: payload.status, comment: { body: payload.comment } }));
      });
      const comment = "Done\n\n- Saved [report](/TST/issues/TST-1#document-report)\n- Literal `code`, $HOME and $(not-a-command)";
      const result = await runHelper(baseUrl, ["--issue-id", "issue-1", "--status", "done"], {
        helper: path.join(installed, "scripts/paperclip-issue-update.sh"), cwd, input: comment,
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "done", comment: { body: comment } });
      expect(savedComments).toEqual([comment]);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: "PATCH", url: "/api/issues/issue-1", authorization: "Bearer test-key", runId: "test-run" });
    });

  it("keeps the repository entrypoint working outside the repository", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-helper-wrapper-"));
    cleanupFns.push(() => fs.rm(root, { recursive: true, force: true }));
    const result = await runHelper("", [...doneArgs, "--dry-run"], { helper: REPO_HELPER_PATH, cwd: root });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: "done", comment });
  });

  it("fails an empty 2xx body instead of treating it as success", async () => {
    const { baseUrl, requests } = await startServer((_request, _attempt, res) => {
      res.writeHead(200, { "content-length": "0" });
      res.end();
    });

    const result = await runHelper(baseUrl, doneArgs);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("empty response body");
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["wrong issue id", { id: "issue-2", status: "done", comment: { body: comment } }],
    ["wrong id and identifier", { id: "other-uuid", identifier: "TST-999", status: "done", comment: { body: comment } }],
    ["missing comment", { id: "issue-1", status: "done" }],
    ["different comment", { id: "issue-1", status: "done", comment: { body: "different" } }],
    ["different status", { id: "issue-1", status: "in_progress", comment: { body: comment } }],
    ["non-object JSON", ["issue-1", "done", comment]],
  ])("does not confirm a 2xx response with %s", async (_caseName, responseBody) => {
    const { baseUrl, requests } = await startServer((_request, _attempt, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });

    const result = await runHelper(baseUrl, doneArgs);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unconfirmed");
    expect(requests).toHaveLength(1);
  });

  it("does not confirm invalid JSON or replay the comment", async () => {
    const { baseUrl, requests } = await startServer((_request, _attempt, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{invalid");
    });

    const result = await runHelper(baseUrl, doneArgs);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unconfirmed");
    expect(requests).toHaveLength(1);
  });

  it("rejects multiple JSON values even when the last object matches", async () => {
    const { baseUrl, requests } = await startServer((_request, _attempt, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`${JSON.stringify({ id: "other-issue" })}\n${JSON.stringify({ id: "issue-1", status: "done", comment: { body: comment } })}`);
    });

    const result = await runHelper(baseUrl, doneArgs);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unconfirmed");
    expect(requests).toHaveLength(1);
  });

  it("does not replay a comment after a 5xx ambiguous outcome", async () => {
    const { baseUrl, requests } = await startServer((_request, _attempt, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unavailable" }));
    });

    const result = await runHelper(baseUrl, doneArgs);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("outcome is ambiguous");
    expect(requests).toHaveLength(1);
  });

  it("does not retry a definitive 4xx rejection", async () => {
    const { baseUrl, requests } = await startServer((_request, _attempt, res) => {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "validation" }));
    });

    const result = await runHelper(baseUrl, doneArgs);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("rejected (HTTP 422)");
    expect(requests).toHaveLength(1);
  });

  it("retries a 5xx once and succeeds when the retry lands", async () => {
    const { baseUrl, requests } = await startServer((request, attempt, res) => {
      if (attempt === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unavailable" }));
        return;
      }
      const payload = JSON.parse(request.body) as { status?: string };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "issue-1", status: payload.status }));
    });

    const result = await runHelper(baseUrl, ["--issue-id", "issue-1", "--status", "done"]);

    expect(result.code).toBe(0);
    expect(requests).toHaveLength(2);
    expect(result.stderr).toContain("retrying");
  });

  it("does not replay a comment after a connection-level failure", async () => {
    // Bind and close a listener so the port is real but refuses connections.
    const probe = http.createServer();
    await new Promise<void>((resolve) => {
      probe.listen(0, "127.0.0.1", resolve);
    });
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      probe.close(() => resolve());
    });

    const result = await runHelper(`http://127.0.0.1:${port}`, doneArgs);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("outcome is ambiguous");
  }, 15_000);
});
