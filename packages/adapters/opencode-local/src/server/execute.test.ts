import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    runAdapterExecutionTargetProcess: vi.fn(),
    runAdapterExecutionTargetShellCommand: vi.fn(),
  };
});

import { ensureRemoteOpenCodeModelConfiguredAndAvailable, execute, verifyRemoteOperationalSkillDir } from "./execute.js";
import { runAdapterExecutionTargetProcess, runAdapterExecutionTargetShellCommand } from "@paperclipai/adapter-utils/execution-target";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";

const runProcessMock = vi.mocked(runAdapterExecutionTargetProcess);
const runShellCommandMock = vi.mocked(runAdapterExecutionTargetShellCommand);

async function createSkillDir(root: string, name: string): Promise<string> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `# ${name}\n`, "utf8");
  return skillDir;
}

function probeResult(overrides: Record<string, unknown>) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
    ...overrides,
  } as never;
}

describe("OpenCode local skill injection", () => {
  let configHome: string;

  beforeEach(async () => {
    configHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-config-"));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(configHome, { recursive: true, force: true });
  });

  it("delivers discovered image input to the process without changing its configured model", async () => {
    const server = createServer((_req, res) => res.writeHead(200).end(JSON.stringify({
      data: [{ id: "alias", capabilities: { vision: true } }],
    })));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    const commandPath = path.join(configHome, "fake-opencode-image");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValue(probeResult({ stdout: JSON.stringify({ type: "text", part: { text: "done" } }) }));
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    try {
      await execute({
        runId: "image-input-run",
        agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: commandPath, cwd: configHome, model: "paperclip/alias", managedAiConnection: true, paperclipSkillMode: "disabled",
          env: { PAPERCLIP_AI_PROVIDER_URL: baseURL, PAPERCLIP_AI_PROVIDER_KEY: "fixture-key",
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { paperclip: {
              options: { baseURL, apiKey: "fixture-key" }, models: { alias: { name: "alias" } },
            } } }),
          } },
        context: {}, onLog: async () => {},
      });
      const call = runProcessMock.mock.calls.find(([, , , args]) => args[0] === "run");
      expect(call).toBeDefined();
      expect(call![3]).toContain("paperclip/alias");
      expect(JSON.parse(call![4].env.OPENCODE_CONFIG_CONTENT).provider.paperclip.models.alias.modalities.input).toContain("image");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it.each([false, true])("keeps chat policy with a legacy OpenCode prompt (custom=%s)", async (custom) => {
    const commandPath = path.join(configHome, "fake-opencode");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValue(probeResult({ stdout: JSON.stringify({
      type: "text", sessionID: "chat-session", part: { text: "Reply" },
    }) }));
    const directive = "Chat directive: clarify goals and hand plans off to project tasks.";
    let prompt = "";
    const result = await execute({
      runId: "chat-run",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" },
        ...(custom ? { promptTemplate: "Custom agent instruction." } : {}),
      },
      context: {
        conversationMode: true,
        paperclipTaskMarkdown: directive,
        paperclipWake: {
          reason: "issue_commented", issue: { id: "chat-1", status: "in_progress", workMode: "planning" },
          interactionKind: "request_confirmation", interactionStatus: "accepted",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => { prompt = String(meta.prompt ?? ""); },
    });
    expect(result.exitCode).toBe(0);
    expect(prompt).toContain(directive);
    expect(prompt).toContain(custom ? "Custom agent instruction." : "You are agent agent-1");
    expect(prompt).not.toContain("Execution contract:");
    expect(prompt).not.toContain("Create child issues");
  });

  it("passes only the supplied runtime MCP servers into OpenCode and cleans the private config", async () => {
    const commandPath = path.join(configHome, "fake-opencode-runtime-mcp");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);
    const token = "fixture-runtime-mcp-token";
    let runtimeConfigHome = "";
    let runtimeMcpConfig: Record<string, Record<string, unknown>> = {};
    let logs = "";
    runProcessMock.mockReset().mockImplementationOnce(async (...args) => {
      const env = (args[4] as { env: Record<string, string> }).env;
      runtimeConfigHome = env.XDG_CONFIG_HOME!;
      const runtimeConfig = JSON.parse(
        await fs.readFile(path.join(runtimeConfigHome, "opencode", "opencode.json"), "utf8"),
      ) as { mcp: Record<string, Record<string, unknown>> };
      runtimeMcpConfig = runtimeConfig.mcp;
      const injected = Object.values(runtimeMcpConfig).find((server) => server.type === "remote")!;
      const authorization = (injected.headers as Record<string, string>).Authorization;
      expect(authorization).toBe(`Bearer ${token}`);
      expect(Object.keys(env).filter((key) => key.startsWith("PAPERCLIP_OPENCODE_MCP_TOKEN_"))).toEqual([]);
      return probeResult({ stdout: JSON.stringify({ type: "text", sessionID: "runtime-mcp", part: { text: "done" } }) });
    });

    const result = await execute({
      runId: "run-runtime-mcp",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
      context: {},
      runtimeMcp: { getServers: () => [{
        name: "assigned",
        url: "https://paperclip.example/mcp/gateways/assigned",
        token,
        connectionId: "connection-assigned",
      }] },
      onLog: async (_stream, chunk) => { logs += chunk; },
    });

    expect(result.exitCode).toBe(0);
    expect(Object.values(runtimeMcpConfig)).toHaveLength(1);
    expect(JSON.stringify(runtimeMcpConfig)).toContain(`Bearer ${token}`);
    expect(logs).not.toContain(token);
    await expect(fs.access(runtimeConfigHome)).rejects.toThrow();
  });

  it("does not expose provider config or auth-content credentials in run metadata", async () => {
    const commandPath = path.join(configHome, "fake-opencode-provider-secret");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);
    const providerKey = "fixture-inline-provider-key-never-a-real-secret";
    runProcessMock.mockReset().mockResolvedValueOnce(probeResult({
      stdout: JSON.stringify({ type: "text", sessionID: "provider-secret", part: { text: "done" } }),
    }));
    let metadataEnv: Record<string, string> = {};
    const result = await execute({
      runId: "run-provider-secret-redaction",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath,
        cwd: configHome,
        model: "paperclip/simple",
        env: {
          OPENCODE_ALLOW_ALL_MODELS: "1",
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            provider: { paperclip: { npm: "@ai-sdk/openai-compatible", options: { apiKey: providerKey } } },
          }),
        },
      },
      context: {},
      onLog: async () => {},
      onMeta: async (meta) => { metadataEnv = (meta.env ?? {}) as Record<string, string>; },
    });

    expect(result.exitCode).toBe(0);
    expect(metadataEnv.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(metadataEnv.OPENCODE_AUTH_CONTENT).toBeUndefined();
    expect(JSON.stringify(metadataEnv)).not.toContain(providerKey);
  });

  it("delivers assignment context on an ordinary task turn and rebuilds it after resume fallback", async () => {
    const commandPath = path.join(configHome, "fake-opencode-context");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const prompts: string[] = [];
    runProcessMock
      .mockReset()
      .mockResolvedValueOnce(probeResult({ stdout: JSON.stringify({ type: "error", error: "unknown session" }) }))
      .mockResolvedValueOnce(probeResult({ stdout: JSON.stringify({ type: "text", sessionID: "fresh", part: { text: "done" } }) }));
    await execute({
      runId: "run-context-fallback",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: "previous", sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
      context: createPromptContextFixture(),
      onLog: async () => {},
      onMeta: async (meta) => { prompts.push(String(meta.prompt ?? "")); },
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("## Compact assignment");
    expect(prompts[1]).toContain("## Owned assignment");
    for (const prompt of prompts) expect(prompt).not.toContain("Execution contract:");
    expect(prompts[1]).toContain("You are agent agent-1 (OpenCode).");
    expect(prompts[1]).toContain("Connection tools:");
    expect(prompts[1]).toContain("command -v python3");
    expect(prompts[1]).toContain("Get-Command python3, python, py");
    expect(prompts[1]).toContain("py -3 --version");
    expect(prompts[1]).toContain("availability already verified for this same shell and execution target");
    expect(prompts[1]).toContain("combine the check with the intended operation in one shell invocation when practical");
    expect(prompts[1]).toContain("do not spend a separate model round on preflight alone");
    expect(prompts[1]).toContain("Repeat discovery after the shell or target changes");
    expect(prompts[1]).toContain("Never infer executable availability from the Paperclip host");
    expect(prompts[1]).toContain("command -v rg");
    expect(prompts[1]).toContain("use `grep`");
    expect(prompts[1]).toContain("Select-String");
    expect(prompts[1]).toContain("PowerShell `ConvertFrom-Json`");
    expect(prompts[1]).toContain("check the transport result and confirm the HTTP status is successful before parsing the body");
    expect(prompts[1]).toContain("If the status is non-2xx or the body is unexpected");
    expect(prompts[1]).toContain("Never append a `curl -w` status marker");
    expect(prompts[1]).toContain("do not blindly retry a parse failure");
    expect(prompts[1]).toContain("follow the search tool's documented query semantics");
    expect(prompts[1]).toContain("no result from a narrower filter or mismatched query does not prove the tool is unavailable");
  });

  it.each(["fresh", "resumed", "recovery"] as const)(
    "includes durable deferred-check guidance in the %s prompt",
    async (mode) => {
      const commandPath = path.join(configHome, `fake-opencode-monitor-${mode}`);
      await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      runProcessMock.mockReset().mockResolvedValueOnce(probeResult({
        stdout: JSON.stringify({ type: "text", sessionID: "monitor-session", part: { text: "done" } }),
      }));
      const context = mode === "resumed"
        ? { ...createPromptContextFixture(), issueId: "issue-1" }
        : {
            issueId: "issue-1",
            ...(mode === "recovery" ? {
              paperclipWake: {
                reason: "source_scoped_recovery_action",
                issue: { id: "issue-1", status: "in_progress" },
                recovery: { cause: "process_lost" },
              },
            } : {}),
          };
      let prompt = "";

      const result = await execute({
        runId: `run-monitor-${mode}`,
        agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
        runtime: { sessionId: mode === "resumed" ? "prior-session" : null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
        context,
        authToken: "run-token-must-not-appear-in-prompt",
        onLog: async () => {},
        onMeta: async (meta) => { prompt = String(meta.prompt ?? ""); },
      });

      expect(result.exitCode).toBe(0);
      expect(prompt).toContain("Paperclip durable deferred-check contract:");
      expect(prompt).toContain("expectedExecutionPolicy is exactly that snapshot");
      expect(prompt).toContain("X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID");
      expect(prompt).toContain("Read the issue back and verify the persisted monitor");
      expect(prompt).toContain("Scheduling a monitor must not change task status, assignee, reviewer, or approval state");
      expect(prompt).toContain("repeated identical remote PowerShell tool call may return its prior receipt");
      expect(prompt).not.toContain("run-token-must-not-appear-in-prompt");
    },
  );

  it.each([true, false])(
    "adds legacy artifact handoff guidance only with run-scoped authority (auth=%s)",
    async (hasAuth) => {
      const commandPath = path.join(configHome, `fake-opencode-artifact-guidance-${hasAuth}`);
      const skillSource = await createSkillDir(configHome, `operational-paperclip-skill-${hasAuth}`);
      await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      runProcessMock.mockReset().mockResolvedValueOnce(probeResult({
        stdout: JSON.stringify({ type: "text", sessionID: "artifact-guidance", part: { text: "done" } }),
      }));
      let prompt = "";
      const skillDir = path.join(configHome, "agent-home", ".claude", "skills", "paperclip");
      const secret = "run-token-must-not-appear-in-prompt";

      const result = await execute({
        runId: "run-artifact-guidance",
        agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: configHome,
          model: "openai/gpt-5",
          env: { OPENCODE_ALLOW_ALL_MODELS: "1", HOME: path.join(configHome, "agent-home"), PAPERCLIP_API_URL: "http://paperclip.test" },
          paperclipRuntimeSkills: [{ key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: skillSource }],
        },
        context: { issueId: "issue-artifact-guidance" },
        ...(hasAuth ? { authToken: secret } : {}),
        onLog: async () => {},
        onMeta: async (meta) => { prompt = String(meta.prompt ?? ""); },
      });

      expect(result.exitCode).toBe(0);
      if (hasAuth) {
        expect(prompt).toContain("Paperclip prepared task tools");
        expect(prompt).toContain("read-snapshot --file FILE --sha256 HASH --offset NEXT until complete=true");
        expect(prompt).toContain("set-monitor --at ISO_TIME");
        expect(prompt).toContain("write-document --key KEY --title TITLE --file FILE");
        expect(prompt).toContain("complete-task --summary-file FILE");
        expect(prompt).toContain("outcome=handed_off with taskDone=false");
        expect(prompt).toContain("Paperclip artifact handoff for this non-native OpenCode run:");
        expect(prompt).toContain("absence of an MCP tool named for uploading files does not mean");
        expect(prompt).toContain(skillDir);
        expect(prompt).toContain("scripts/paperclip-upload-artifact.sh");
        expect(prompt).toContain("references/artifacts.md");
        expect(prompt).toContain("does not support the native-only register_deliverable tool");
        expect(prompt).not.toContain(secret);
      } else {
        expect(prompt).not.toContain("Paperclip prepared task tools");
        expect(prompt).not.toContain("Paperclip artifact handoff for this non-native OpenCode run:");
        expect(prompt).not.toContain(skillDir);
      }
    },
  );

  it.each(["existing-target-collision", "deleted-source", "unreadable-skill-file"] as const)(
    "omits artifact guidance when the operational skill was not actually injected (%s)",
    async (failureMode) => {
      const commandPath = path.join(configHome, `fake-opencode-skill-not-loaded-${failureMode}`);
      const agentHome = path.join(configHome, `agent-home-${failureMode}`);
      const source = path.join(configHome, `skill-source-${failureMode}`);
      if (failureMode === "existing-target-collision") {
        await createSkillDir(configHome, `skill-source-${failureMode}`);
        const collision = path.join(agentHome, ".claude", "skills", "paperclip");
        await fs.mkdir(collision, { recursive: true });
        await fs.writeFile(path.join(collision, "SKILL.md"), "unrelated skill", "utf8");
      } else if (failureMode === "unreadable-skill-file") {
        await createSkillDir(configHome, `skill-source-${failureMode}`);
      }
      await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      runProcessMock.mockReset().mockResolvedValueOnce(probeResult({
        stdout: JSON.stringify({ type: "text", sessionID: "skill-not-loaded", part: { text: "done" } }),
      }));
      let prompt = "";
      const readFileSpy = failureMode === "unreadable-skill-file"
        ? vi.spyOn(fs, "readFile").mockRejectedValueOnce(new Error("read denied"))
        : null;

      let result;
      try {
        result = await execute({
          runId: `run-skill-not-loaded-${failureMode}`,
          agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
          config: {
            command: commandPath,
            cwd: configHome,
            model: "openai/gpt-5",
            env: { OPENCODE_ALLOW_ALL_MODELS: "1", HOME: agentHome, PAPERCLIP_API_URL: "http://paperclip.test" },
            paperclipRuntimeSkills: [{
              key: "paperclipai/paperclip/paperclip",
              runtimeName: "paperclip",
              source,
            }],
          },
          context: { issueId: "issue-skill-not-loaded" },
          authToken: "run-token-must-not-appear-in-prompt",
          onLog: async () => {},
          onMeta: async (meta) => { prompt = String(meta.prompt ?? ""); },
        });
      } finally {
        readFileSpy?.mockRestore();
      }

      expect(result.exitCode).toBe(0);
      expect(prompt).not.toContain("Paperclip artifact handoff for this non-native OpenCode run:");
      if (failureMode === "existing-target-collision") {
        expect(await fs.readFile(path.join(agentHome, ".claude", "skills", "paperclip", "SKILL.md"), "utf8"))
          .toBe("unrelated skill");
      }
    },
  );

  it("requires successful remote copy and a readable operational SKILL.md before adding its path", async () => {
    const input = {
      runId: "run-remote-skill-proof",
      target: { kind: "remote", transport: "ssh" } as never,
      skillDir: "/remote/home/.claude/skills/paperclip",
      cwd: "/remote/workspace",
      env: {},
      timeoutSec: 10,
      graceSec: 2,
      onLog: async () => {},
    };
    runShellCommandMock.mockReset().mockResolvedValueOnce(probeResult({ exitCode: 1 }));
    await expect(verifyRemoteOperationalSkillDir({ ...input, copyResult: { exitCode: 1, timedOut: false } }))
      .resolves.toBe("");
    expect(runShellCommandMock).not.toHaveBeenCalled();

    runShellCommandMock.mockReset().mockResolvedValueOnce(probeResult({ exitCode: 1 }));
    await expect(verifyRemoteOperationalSkillDir({ ...input, copyResult: { exitCode: 0, timedOut: false } }))
      .resolves.toBe("");
    expect(runShellCommandMock).toHaveBeenCalledWith(
      input.runId,
      input.target,
      "test -f '/remote/home/.claude/skills/paperclip/SKILL.md' && test -r '/remote/home/.claude/skills/paperclip/SKILL.md'",
      expect.objectContaining({ cwd: input.cwd }),
    );

    runShellCommandMock.mockReset().mockResolvedValueOnce(probeResult({ exitCode: 0 }));
    await expect(verifyRemoteOperationalSkillDir({ ...input, copyResult: { exitCode: 0, timedOut: false } }))
      .resolves.toBe(input.skillDir);

    runShellCommandMock.mockReset().mockRejectedValueOnce(new Error("transport unavailable"));
    await expect(verifyRemoteOperationalSkillDir({ ...input, copyResult: { exitCode: 0, timedOut: false } }))
      .resolves.toBe("");

    runShellCommandMock.mockReset().mockResolvedValueOnce(probeResult({ exitCode: null, timedOut: true }));
    await expect(verifyRemoteOperationalSkillDir({ ...input, copyResult: { exitCode: 0, timedOut: false } }))
      .resolves.toBe("");
  });

  it("fails a fresh-session retry that exits cleanly without assistant output or a completed tool action", async () => {
    const commandPath = path.join(configHome, "fake-opencode-empty-retry");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const emptyStdout = [
      JSON.stringify({ type: "step_start", sessionID: "fresh-session" }),
      JSON.stringify({ type: "step_finish", sessionID: "fresh-session", part: {
        reason: "stop", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } }),
    ].join("\n");
    runProcessMock.mockReset()
      .mockResolvedValueOnce(probeResult({ stdout: JSON.stringify({ type: "error", error: "Session not found: previous-session" }) }))
      .mockResolvedValueOnce(probeResult({ stdout: emptyStdout }));

    const result = await execute({
      runId: "run-empty-fresh-session-retry",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: "previous-session", sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
      context: {},
      onLog: async () => {},
    });

    expect(runProcessMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "opencode_empty_response",
      errorMessage: "OpenCode completed without an assistant response or completed tool action",
      sessionId: "fresh-session",
      summary: "",
      resultJson: { stdout: emptyStdout },
    });
  });

  it("fails a whitespace-only assistant completion", async () => {
    const commandPath = path.join(configHome, "fake-opencode-whitespace");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock.mockReset().mockResolvedValueOnce(probeResult({ stdout: [
      JSON.stringify({ type: "text", sessionID: "whitespace-session", part: { text: "  \n  " } }),
      JSON.stringify({ type: "step_finish", sessionID: "whitespace-session", part: { reason: "stop", tokens: { input: 3, output: 0 } } }),
    ].join("\n") }));

    const result = await execute({
      runId: "run-whitespace-completion",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
      context: {},
      onLog: async () => {},
    });

    expect(result).toMatchObject({ exitCode: 1, errorCode: "opencode_empty_response", summary: "" });
  });

  it("keeps a completed tool-only run successful", async () => {
    const commandPath = path.join(configHome, "fake-opencode-tool-only");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const stdout = JSON.stringify({
      type: "tool_use",
      sessionID: "tool-only-session",
      part: { tool: "bash", state: { status: "completed", output: "updated the workspace" } },
    });
    runProcessMock.mockReset().mockResolvedValueOnce(probeResult({ stdout }));

    const result = await execute({
      runId: "run-tool-only",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
      context: {},
      onLog: async () => {},
    });

    expect(result).toMatchObject({ exitCode: 0, errorMessage: null, errorCode: null, summary: "" });
  });

  it("injects runtime skills into the configured child HOME", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-configured-home-"));
    const processHome = path.join(root, "process-home");
    const configuredHome = path.join(root, "configured-home");
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const skillSource = await createSkillDir(path.join(root, "runtime-skills"), "paperclip");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);

    const previousHome = process.env.HOME;
    process.env.HOME = processHome;
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValueOnce(probeResult({
      stdout: JSON.stringify({
        type: "text",
        sessionID: "session-configured-home",
        part: { text: "done" },
      }),
    }));

    try {
      const result = await execute({
        runId: "run-configured-home",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Coder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "openai/gpt-5",
          env: {
            HOME: configuredHome,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          paperclipRuntimeSkills: [{
            key: "paperclipai/paperclip/paperclip",
            runtimeName: "paperclip",
            source: skillSource,
          }],
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const installedSkill = path.join(configuredHome, ".claude", "skills", "paperclip");
      expect((await fs.lstat(installedSkill)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(installedSkill)).toBe(await fs.realpath(skillSource));
      await expect(fs.lstat(path.join(processHome, ".claude", "skills", "paperclip"))).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])("preserves API billing in streamed usage and final results without leaking keys (timedOut=%s)", async (timedOut) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-openrouter-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const apiKey = "openrouter-test-secret";
    const model = "openrouter/anthropic/claude-sonnet-4.5";
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);
    runProcessMock.mockReset();
    const usageLine = JSON.stringify({ type: "step_finish", sessionID: "session-openrouter",
      part: { cost: 0.0025, tokens: { input: 10, output: 2, cache: { read: 100, write: 0 } } } });
    const stdout = [
      ...(timedOut ? [] : [JSON.stringify({ type: "text", sessionID: "session-openrouter", part: { text: "done" } })]),
      usageLine,
    ].join("\n");
    runProcessMock.mockImplementationOnce(async (...args) => {
      await args[4].onLog("stdout", `${stdout}\n`);
      return probeResult({ stdout, timedOut, exitCode: timedOut ? 143 : 0, signal: timedOut ? "SIGTERM" : null });
    });
    const logs: string[] = [];
    const metadata: unknown[] = [];
    const onUsage = vi.fn();

    try {
      const result = await execute({
        runId: "run-openrouter",
        agent: {
          id: "agent-openrouter",
          companyId: "company-1",
          name: "OpenRouter Coder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model,
          env: {
            OPENROUTER_API_KEY: apiKey,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          promptTemplate: "Run the task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onUsage,
        onLog: async (_stream, chunk) => {
          logs.push(chunk);
        },
        onMeta: async (value) => {
          metadata.push(value);
        },
      });

      expect(result.exitCode).toBe(timedOut ? 143 : 0);
      expect(result.errorMessage).toBe(timedOut ? "OpenCode execution timed out" : null);
      expect(result.usageComplete).toBe(!timedOut);
      expect(result.model).toBe(model);
      expect(result.billingType).toBe("metered_api");
      expect(result.biller).toBe("openrouter");
      expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ billingType: "metered_api", biller: "openrouter", model, complete: false }));
      expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ billingType: "metered_api", biller: "openrouter", model, complete: !timedOut }));
      const executionCall = runProcessMock.mock.calls.at(-1)!;
      expect(executionCall[3]).toContain("--model");
      expect(executionCall[3]).toContain(model);
      expect((executionCall[4] as { env: Record<string, string> }).env.OPENROUTER_API_KEY).toBe(apiKey);
      expect(JSON.stringify({ logs, metadata, result })).not.toContain(apiKey);
      expect(JSON.stringify(metadata)).toContain('"OPENROUTER_API_KEY":"***REDACTED***"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("OpenCode runtime MCP handoff", () => {
  let configHome: string;

  beforeEach(async () => {
    configHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-mcp-handoff-"));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    vi.stubEnv("OPENCODE_ALLOW_ALL_MODELS", "1");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(configHome, { recursive: true, force: true });
  });

  it("passes the run MCP server into OpenCode and removes its local secret config after execution", async () => {
    const commandPath = path.join(configHome, "fake-opencode-mcp");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);
    const secret = "runtime-mcp-run-secret";
    let configPath = "";
    let configAtExecution: Record<string, unknown> | undefined;
    const logOutput: string[] = [];

    runProcessMock.mockReset();
    runProcessMock.mockImplementation(async (...args) => {
      const options = args[4] as { env: Record<string, string> };
      if (args[3].includes("run")) {
        configPath = path.join(options.env.XDG_CONFIG_HOME, "opencode", "opencode.json");
        configAtExecution = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
      }
      return probeResult({ stdout: JSON.stringify({ type: "text", sessionID: "mcp-session", part: { text: "done" } }) });
    });

    const result = await execute({
      runId: "run-mcp-handoff",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath,
        cwd: configHome,
        model: "openai/gpt-5",
        dangerouslySkipPermissions: false,
        env: { OPENCODE_ALLOW_ALL_MODELS: "1" },
      },
      context: {},
      runtimeMcp: {
        getServers: () => [{
          name: "PowerShell on Felix PC",
          connectionId: "felix-pc-powershell",
          url: "https://paperclip.example/api/mcp/run-1",
          token: secret,
        }],
      },
      onLog: async (_stream, chunk) => { logOutput.push(chunk); },
    });

    expect(result.exitCode).toBe(0);
    expect(configAtExecution?.permission).toBeUndefined();
    const assignedMcp = Object.entries(configAtExecution?.mcp as Record<string, unknown> | undefined ?? {}).find(([, server]) =>
      typeof server === "object" && server !== null && "url" in server && server.url === "https://paperclip.example/api/mcp/run-1",
    );
    expect(assignedMcp).toBeDefined();
    expect(assignedMcp?.[0]).toMatch(/^paperclip_[A-F0-9]{12}$/);
    expect(assignedMcp?.[1]).toMatchObject({
      type: "remote",
      url: "https://paperclip.example/api/mcp/run-1",
      headers: { Authorization: `Bearer ${secret}` },
      oauth: false,
    });
    expect(JSON.stringify({ result, logs: logOutput })).not.toContain(secret);
    await expect(fs.access(configPath)).rejects.toThrow();
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable — probe is non-fatal when it cannot run", () => {
  const target = { kind: "remote", transport: "ssh" } as never;
  const base = {
    runId: "run-probe",
    executionTarget: target,
    command: "opencode",
    cwd: "/tmp",
    env: {} as Record<string, string>,
    timeoutSec: 30,
    graceSec: 5,
  };

  beforeEach(() => {
    runProcessMock.mockReset();
  });

  it("proceeds when the remote probe exits non-zero (e.g. a transient `Unexpected error`)", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 1, stderr: "Unexpected error" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("proceeds when the remote probe times out", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ timedOut: true, exitCode: null }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("proceeds when the remote probe returns no models", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 0, stdout: "" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("still rejects when the probe succeeds but the configured model is absent (guard retained)", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 0, stdout: "openai/gpt-4.1\n" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).rejects.toThrow("Configured OpenCode model is unavailable on the remote execution target");
  });
});
