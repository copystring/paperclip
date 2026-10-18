import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";

const cleanupPaths = new Set<string>();
const encoder = new TextEncoder();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

async function makeConfigHome(initialConfig?: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-"));
  cleanupPaths.add(root);
  const configDir = path.join(root, "opencode");
  await fs.mkdir(configDir, { recursive: true });
  if (initialConfig) {
    await fs.writeFile(
      path.join(configDir, "opencode.json"),
      `${JSON.stringify(initialConfig, null, 2)}\n`,
      "utf8",
    );
  }
  return root;
}

describe("prepareOpenCodeRuntimeConfig", () => {
  it("preserves configured model modalities when the inline layer defines that model", async () => {
    const configHome = await makeConfigHome({
      provider: { gateway: { models: { vision: { modalities: ["text", "image"] } } } },
    });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { gateway: { models: { vision: {} } } } }),
      },
      config: { model: "gateway/vision", dangerouslySkipPermissions: false },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    expect(JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      provider: { gateway: { models: { vision: { modalities: ["text", "image"] } } } },
    });
    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });

  it.each([true, false])("prepares explicit remote runtime settings without reading host config (skipPermissions=%s)", async (skipPermissions) => {
    const configHome = await makeConfigHome({ theme: "host-only", permission: { bash: "deny" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({ gateway: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://gateway.example/v1", apiKey: "{env:GATEWAY_KEY}" },
          models: { "gateway/model": { name: "Gateway Model" } },
        } }),
        GATEWAY_KEY: "runtime-key-value",
        PAPERCLIP_OPENCODE_SMALL_MODEL: "gateway/model",
      },
      config: { model: "gateway/model", dangerouslySkipPermissions: skipPermissions },
      targetIsRemote: true,
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME!);

    expect(prepared.runtimeConfigHome).toBe(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfigPath = path.join(prepared.env.XDG_CONFIG_HOME!, "opencode", "opencode.json");
    const runtimeConfig = JSON.parse(await fs.readFile(runtimeConfigPath, "utf8")) as Record<string, unknown>;
    expect(runtimeConfig.theme).toBeUndefined();
    expect(runtimeConfig).toMatchObject({
      provider: { gateway: { options: { apiKey: "runtime-key-value" } } },
      small_model: "gateway/model",
    });
    expect(runtimeConfig.permission).toBe(skipPermissions ? "allow" : undefined);
    expect(prepared.notes.join(" ")).not.toContain("runtime-key-value");

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME!);
    await expect(fs.access(prepared.env.XDG_CONFIG_HOME!)).rejects.toThrow();
  });

  it("does not create a remote config when permissions are enabled and no runtime settings need transport", async () => {
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {},
      config: { dangerouslySkipPermissions: false },
      targetIsRemote: true,
    });

    expect(prepared.runtimeConfigHome).toBeNull();
    expect(prepared.env.XDG_CONFIG_HOME).toBeUndefined();
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });

  it("ships task tools privately and removes them with the runtime configuration", async () => {
    const configHome = await makeConfigHome();
    const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: configHome }, config: {} });
    expect(prepared.taskToolsPath).toBeTruthy();
    expect(await fs.readFile(prepared.taskToolsPath!, "utf8")).toContain("expectedExecutionPolicy");
    if (process.platform !== "win32") expect((await fs.stat(prepared.taskToolsPath!)).mode & 0o777).toBe(0o600);
    await prepared.cleanup();
    await expect(fs.access(prepared.taskToolsPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("adds a private provider timeout hook only when the configured provider credential is available", async () => {
    const apiKey = "fixture-config-provider-key-never-a-real-secret";
    const configHome = await makeConfigHome({
      provider: {
        paperclip: {
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey },
          models: { simple: {} },
        },
      },
    });
    const dataHome = await makeConfigHome();
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome },
      config: { model: "paperclip/simple" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider: Record<string, { options?: Record<string, unknown>; models?: Record<string, { options?: Record<string, unknown> }> }> };
    expect(runtimeConfig.provider.paperclip.options?.timeout).toBeUndefined();
    expect(runtimeConfig.provider.paperclip.models?.simple?.options?.timeout).toBeUndefined();
    expect(prepared.env.XDG_DATA_HOME).toBe(dataHome);
    const auth = JSON.parse(prepared.env.OPENCODE_AUTH_CONTENT!) as Record<string, { type: string; key: string }>;
    expect(auth).toEqual({ paperclip: { type: "api", key: apiKey } });
    const pluginDir = path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "plugins");
    const [pluginName] = await fs.readdir(pluginDir);
    const pluginSource = await fs.readFile(path.join(pluginDir, pluginName), "utf8");
    expect(pluginSource).toContain('provider: providerName');
    expect(pluginSource).toContain('"tool.execute.before"');
    expect(pluginSource).toContain('finish_reason === "tool_calls"');
    expect(pluginSource).toContain("MAX_PENDING_CHARS");
    expect(pluginSource).toContain("parserUncertain");
    expect(pluginSource).toContain('requestBody.model');
    expect(pluginSource).toContain("normalizedTimeoutRetries < retryBudget");
    expect(pluginSource).toContain("const retryBudget = 2;");
    expect(pluginSource).not.toContain(apiKey);
    expect(prepared.notes.join("\n")).not.toContain(apiKey);
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(pluginDir, pluginName)).then((s) => s.mode & 0o777))).toBe(0o600);
    }

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
    await expect(fs.access(prepared.env.XDG_DATA_HOME!)).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(configHome, "opencode", "opencode.json"), "utf8")).toContain(apiKey);
  });

  it("fails the optional timeout feature closed for a copied plugins-directory symlink", async () => {
    const apiKey = "fixture-private-plugin-key";
    const configHome = await makeConfigHome({
      provider: { paperclip: { npm: "@ai-sdk/openai-compatible", options: { apiKey } } },
    });
    const outsidePlugins = path.join(configHome, "user-plugins");
    await fs.mkdir(outsidePlugins);
    const userPlugin = path.join(outsidePlugins, "user-plugin.js");
    await fs.writeFile(userPlugin, "export const UserPlugin = async () => ({});", "utf8");
    await fs.symlink(outsidePlugins, path.join(configHome, "opencode", "plugins"), "junction");
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { model: "paperclip/simple" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimePluginDir = path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "plugins");
    expect((await fs.lstat(runtimePluginDir)).isSymbolicLink()).toBe(true);
    expect(prepared.notes.join("\n")).toContain("plugins directory is a symlink");
    expect(await fs.readFile(userPlugin, "utf8")).toContain("UserPlugin");
    expect(await fs.readdir(outsidePlugins)).toEqual(["user-plugin.js"]);
    await prepared.cleanup();
  });

  it("preserves existing plugin files and omits timeout-hook composition when hooks may conflict", async () => {
    const configHome = await makeConfigHome({
      provider: { paperclip: { npm: "@ai-sdk/openai-compatible", options: { apiKey: "fixture-key" } } },
    });
    const pluginDir = path.join(configHome, "opencode", "plugins");
    await fs.mkdir(pluginDir);
    const userPluginPath = path.join(pluginDir, "user-plugin.js");
    await fs.writeFile(userPluginPath, "export const UserPlugin = async () => ({});", "utf8");
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { model: "paperclip/simple" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const copiedPluginDir = path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "plugins");
    expect(await fs.readFile(path.join(copiedPluginDir, "user-plugin.js"), "utf8")).toContain("UserPlugin");
    expect(await fs.readdir(copiedPluginDir)).toEqual(["user-plugin.js"]);
    expect(prepared.notes.join("\n")).toContain("existing plugins prevent safe fetch-hook composition");
    await prepared.cleanup();
    expect(await fs.readFile(userPluginPath, "utf8")).toContain("UserPlugin");
  });

  it("uses the supported auth-content override while preserving other existing provider auth", async () => {
    const configHome = await makeConfigHome({
      provider: { paperclip: { npm: "@ai-sdk/openai-compatible", models: { simple: {} } } },
    });
    const dataHome = await makeConfigHome();
    const sourceAuthDir = path.join(dataHome, "opencode");
    await fs.mkdir(sourceAuthDir, { recursive: true });
    const selectedAuth = { type: "api", key: "fixture-static-auth-key" };
    await fs.writeFile(path.join(sourceAuthDir, "auth.json"), JSON.stringify({ paperclip: selectedAuth, unrelated: { type: "api", key: "fixture-other-key" } }));
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome },
      config: { model: "paperclip/simple" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeAuth = JSON.parse(prepared.env.OPENCODE_AUTH_CONTENT!) as Record<string, unknown>;
    expect(runtimeAuth).toEqual({ paperclip: selectedAuth, unrelated: { type: "api", key: "fixture-other-key" } });
    expect(prepared.env.XDG_DATA_HOME).toBe(dataHome);
    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
    expect(JSON.parse(await fs.readFile(path.join(sourceAuthDir, "auth.json"), "utf8"))).toHaveProperty("unrelated");
  });

  it.each([{}, { unrelated: { type: "api", key: "fixture-visible-key" } }])(
    "does not resurrect file credentials hidden by the supplied auth record (%j)", async (authOverride) => {
      const configHome = await makeConfigHome({
        provider: { paperclip: { npm: "@ai-sdk/openai-compatible", models: { simple: {} } } },
      });
      const dataHome = await makeConfigHome();
      const authPath = path.join(dataHome, "opencode", "auth.json");
      const hiddenAuth = JSON.stringify({ paperclip: { type: "api", key: "fixture-hidden-key" } });
      await fs.writeFile(authPath, hiddenAuth);
      const authContent = JSON.stringify(authOverride);
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome, OPENCODE_AUTH_CONTENT: authContent },
        config: { model: "paperclip/simple" },
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
      expect(prepared.env.OPENCODE_AUTH_CONTENT).toBe(authContent);
      expect(prepared.notes.join("\n")).toContain("no usable provider credential");
      await expect(fs.access(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "plugins"))).rejects.toThrow();
      expect(await fs.readFile(authPath, "utf8")).toBe(hiddenAuth);
      await prepared.cleanup();
    },
  );

  it("leaves OAuth-backed auth handling unchanged when no static provider key is configured", async () => {
    const configHome = await makeConfigHome({
      provider: { paperclip: { npm: "@ai-sdk/openai-compatible", models: { simple: {} } } },
    });
    const dataHome = await makeConfigHome();
    const authDir = path.join(dataHome, "opencode");
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(path.join(authDir, "auth.json"), JSON.stringify({
      paperclip: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 123 },
    }));
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome },
      config: { model: "paperclip/simple" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    expect(prepared.env.OPENCODE_AUTH_CONTENT).toBeUndefined();
    expect(prepared.env.XDG_DATA_HOME).toBe(dataHome);
    expect(prepared.notes.join("\n")).toContain("no usable provider credential");
    await prepared.cleanup();
  });

  it.each([0, false])("respects an explicit provider timeout opt-out (%s)", async (timeout) => {
    const configHome = await makeConfigHome({
      provider: { paperclip: { npm: "@ai-sdk/openai-compatible", options: { apiKey: "fixture-key", timeout } } },
    });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { model: "paperclip/simple" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider: Record<string, { options?: Record<string, unknown> }> };
    expect(runtimeConfig.provider.paperclip.options?.timeout).toBe(timeout);
    expect(prepared.env.XDG_DATA_HOME).toBeUndefined();
    await expect(fs.access(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "plugins"))).rejects.toThrow();
    await prepared.cleanup();
  });

  it("preserves longer explicit timeouts and omits values outside the Node timer range", async () => {
    const longTimeoutHome = await makeConfigHome({
      provider: { paperclip: { npm: "@ai-sdk/openai-compatible", options: { apiKey: "fixture-key", timeout: 600_000 } } },
    });
    const longTimeout = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: longTimeoutHome },
      config: { model: "paperclip/simple" },
    });
    cleanupPaths.add(longTimeout.env.XDG_CONFIG_HOME);
    const longTimeoutPlugin = path.join(longTimeout.env.XDG_CONFIG_HOME, "opencode", "plugins", (await fs.readdir(path.join(longTimeout.env.XDG_CONFIG_HOME, "opencode", "plugins")))[0]);
    expect(await fs.readFile(longTimeoutPlugin, "utf8")).toContain("const timeoutMs = 600000;");
    await longTimeout.cleanup();
    cleanupPaths.delete(longTimeout.env.XDG_CONFIG_HOME);

    const unsupportedHome = await makeConfigHome({
      provider: { paperclip: { npm: "@ai-sdk/openai-compatible", options: { apiKey: "fixture-key", timeout: 2_147_483_648 } } },
    });
    const unsupported = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: unsupportedHome },
      config: { model: "paperclip/simple" },
    });
    cleanupPaths.add(unsupported.env.XDG_CONFIG_HOME);
    await expect(fs.access(path.join(unsupported.env.XDG_CONFIG_HOME, "opencode", "plugins"))).rejects.toThrow();
    expect(unsupported.notes.join("\n")).toContain("exceeds the supported Node.js timer range");
    await unsupported.cleanup();
    cleanupPaths.delete(unsupported.env.XDG_CONFIG_HOME);
  });

  it("caps only timeout-triggered retries at two and respects a tighter configured retry limit", async () => {
    const configHome = await makeConfigHome({
      provider: {
        paperclip: {
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "fixture-key", maxRetries: 1 },
        },
      },
    });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { model: "paperclip/simple" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const pluginDir = path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "plugins");
    const [pluginName] = await fs.readdir(pluginDir);
    const pluginSource = await fs.readFile(path.join(pluginDir, pluginName), "utf8");
    expect(pluginSource).toContain("const retryBudget = 1;");
    await prepared.cleanup();
  });

  it("normalizes only a timed-out target-model SSE stream with no completed or uncertain tool call", async () => {
    const configHome = await makeConfigHome({
      provider: {
        paperclip: {
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "fixture-timeout-key" },
          models: { simple: { options: { timeout: 30 } }, auxiliary: {} },
        },
      },
    });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { model: "paperclip/simple" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const pluginDir = path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "plugins");
    const pluginName = (await fs.readdir(pluginDir)).find((name) => name.startsWith("paperclip-model-timeout-"))!;
    const pluginModule = await import(pathToFileURL(path.join(pluginDir, pluginName)).href) as {
      PaperclipModelStepTimeout: () => Promise<Record<string, any>>;
    };
    const hooks = await pluginModule.PaperclipModelStepTimeout();
    const authHooks = await hooks.auth.loader();
    const previousFetch = globalThis.fetch;
    let nextPayload = `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "write", arguments: "" } }] }, finish_reason: null }],
    })}\n\n`;
    let nextStatus = 200;
    let nextContentType = "text/event-stream";
    let operatorAbortController: AbortController | undefined;
    let releaseAuxiliary: (() => void) | undefined;
    let signalAuxiliaryPull!: () => void;
    const auxiliaryPullStarted = new Promise<void>((resolve) => { signalAuxiliaryPull = resolve; });
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const requestModel = JSON.parse(String(init?.body)).model;
      if (requestModel === "auxiliary") {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => { controller.enqueue(encoder.encode("auxiliary-ok")); controller.close(); }, 60);
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      if (requestModel === "auxiliary-hold") {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(encoder.encode("auxiliary-started")); },
          pull(controller) {
            signalAuxiliaryPull();
            return new Promise<void>((resolve) => {
              releaseAuxiliary = () => { controller.close(); resolve(); };
            });
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      if (requestModel === "simple" && operatorAbortController) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "still waiting" }, finish_reason: null }] })}\n\n`)); },
          pull() {
            return new Promise<void>((_resolve, reject) => {
              operatorAbortController!.signal.addEventListener("abort", () => {
                setTimeout(() => reject(operatorAbortController!.signal.reason), 10);
              }, { once: true });
            });
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(encoder.encode(nextPayload)); },
        pull() {
          return new Promise<void>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) reject(signal.reason);
            else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      }), { status: nextStatus, headers: { "content-type": nextContentType } });
    }) as typeof fetch;
    try {
      // A tool completed in an earlier step must not prevent recovery of a later step.
      await hooks["tool.execute.before"]();
      const response = await authHooks.fetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "simple", messages: [] }),
      });
      await expect(response.text()).rejects.toMatchObject({ message: "response timeout" });

      const completedToolEvent = `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call-2", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "x" }) } }] }, finish_reason: null }],
      })}`;
      nextPayload = completedToolEvent; // no event delimiter: timeout flush must detect the complete call
      const completedCallResponse = await authHooks.fetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "simple", messages: [] }),
      });
      const completedCallError = await completedCallResponse.text().then(() => null, (error: unknown) => error);
      expect(completedCallError).not.toMatchObject({ message: "response timeout" });

      nextPayload = `data: ${JSON.stringify({ unsupported: true })}\n\n`;
      const unknownEventResponse = await authHooks.fetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "simple", messages: [] }),
      });
      const unknownEventError = await unknownEventResponse.text().then(() => null, (error: unknown) => error);
      expect(unknownEventError).not.toMatchObject({ message: "response timeout" });

      nextPayload = `data: ${JSON.stringify({ choices: [{ delta: { function_call: { name: "write", arguments: "{}" } }, finish_reason: "function_call" }] })}\n\n`;
      const legacyEventResponse = await authHooks.fetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "simple", messages: [] }),
      });
      const legacyEventError = await legacyEventResponse.text().then(() => null, (error: unknown) => error);
      expect(legacyEventError).not.toMatchObject({ message: "response timeout" });

      nextStatus = 401;
      const unauthorizedResponse = await authHooks.fetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "simple", messages: [] }),
      });
      const unauthorizedError = await unauthorizedResponse.text().then(() => null, (error: unknown) => error);
      expect(unauthorizedError).not.toMatchObject({ message: "response timeout" });

      nextStatus = 200;
      nextContentType = "text/plain";
      const unknownContentTypeResponse = await authHooks.fetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "simple", messages: [] }),
      });
      const unknownContentTypeError = await unknownContentTypeResponse.text().then(() => null, (error: unknown) => error);
      expect(unknownContentTypeError).not.toMatchObject({ message: "response timeout" });

      nextContentType = "text/event-stream";
      operatorAbortController = new AbortController();
      setTimeout(() => operatorAbortController?.abort(new DOMException("operator stop", "AbortError")), 40);
      const operatorAbortResponse = await authHooks.fetch("http://localhost/v1/chat/completions", {
        method: "POST",
        signal: operatorAbortController.signal,
        body: JSON.stringify({ model: "simple", messages: [] }),
      });
      const operatorAbortError = await operatorAbortResponse.text().then(() => null, (error: unknown) => error);
      expect(operatorAbortError).toMatchObject({ name: "AbortError", message: "operator stop" });
      expect(operatorAbortError).not.toMatchObject({ message: "response timeout" });
      operatorAbortController = undefined;

      const auxiliaryResponse = await authHooks.fetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "auxiliary", messages: [] }),
      });
      expect(await auxiliaryResponse.text()).toBe("auxiliary-ok");

      const heldAuxiliaryResponse = await authHooks.fetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "auxiliary-hold", messages: [] }),
      });
      const heldAuxiliaryText = heldAuxiliaryResponse.text();
      await auxiliaryPullStarted;
      nextPayload = `data: ${JSON.stringify({ choices: [{ delta: { content: "still waiting" }, finish_reason: null }] })}\n\n`;
      const overlappedTargetResponse = await authHooks.fetch("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "simple", messages: [] }),
      });
      const overlappedTargetError = await overlappedTargetResponse.text().then(() => null, (error: unknown) => error);
      expect(overlappedTargetError).not.toMatchObject({ message: "response timeout" });
      releaseAuxiliary?.();
      await expect(heldAuxiliaryText).resolves.toContain("auxiliary-started");
      expect(globalThis.fetch).toHaveBeenCalledTimes(10);
    } finally {
      globalThis.fetch = previousFetch;
      await prepared.cleanup();
      cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
    }
  });

  it("preserves OPENCODE_CONFIG_CONTENT and injects selected auth through the supported auth override", async () => {
    const apiKey = "fixture-inline-key-never-a-real-secret";
    const configHome = await makeConfigHome();
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          theme: "system",
          provider: { paperclip: { npm: "@ai-sdk/openai-compatible", options: { apiKey } } },
        }),
      },
      config: { model: "paperclip/simple" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const envContent = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!) as {
      theme: string;
      provider: Record<string, { options?: Record<string, unknown> }>;
    };
    expect(envContent.theme).toBe("system");
    expect(envContent.provider.paperclip.options).toEqual({ apiKey });
    expect(JSON.parse(prepared.env.OPENCODE_AUTH_CONTENT!)).toEqual({ paperclip: { type: "api", key: apiKey } });
    expect(prepared.notes.join("\n")).not.toContain(apiKey);
    await prepared.cleanup();
  });

  it("allows all tools and connected tools by default", async () => {
    const configHome = await makeConfigHome({
      permission: {
        read: "allow",
        bash: "ask",
        "mcp__example__write": "deny",
      },
      theme: "system",
    });

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    expect(prepared.env.XDG_CONFIG_HOME).not.toBe(configHome);
    const runtimeConfig = JSON.parse(
      await fs.readFile(
        path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(runtimeConfig).toMatchObject({
      theme: "system",
      permission: "allow",
    });
    expect(runtimeConfig.mcp).toBeUndefined();

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
    await expect(fs.access(prepared.env.XDG_CONFIG_HOME)).rejects.toThrow();
  });

  it("does not add MCP servers when the delivered assignment is empty", async () => {
    const configHome = await makeConfigHome({
      mcp: { existing: { type: "remote", url: "https://example.test/mcp", enabled: false } },
    });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
      runtimeMcp: [],
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.mcp).toEqual({
      existing: { type: "remote", url: "https://example.test/mcp", enabled: false },
    });
    expect(Object.keys(prepared.env).filter((key) => key.startsWith("PAPERCLIP_OPENCODE_MCP_TOKEN_"))).toEqual([]);
    await prepared.cleanup();
  });

  it("adds only delivered HTTP MCP servers with a Bearer header and preserves user servers on collision", async () => {
    const { createHash } = await import("node:crypto");
    const connectionId = "fixture-connection";
    const suffix = createHash("sha256").update(`${connectionId}\0${0}`).digest("hex").toUpperCase();
    const collidedName = `paperclip_${suffix.slice(0, 12)}`;
    const assignedName = `paperclip_${suffix.slice(0, 10)}_1`;
    expect(collidedName.length).toBeLessThanOrEqual(22);
    const suppliedToken = "fixture-token-not-a-real-credential";
    const configHome = await makeConfigHome({
      mcp: {
        [collidedName]: { type: "local", command: ["user-owned-server"] },
        other: { type: "remote", url: "https://user.example/mcp", enabled: true },
      },
      theme: "system",
    });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
      runtimeMcp: [{
        name: "Paperclip assigned",
        url: "https://paperclip.example/mcp/gateways/run-scoped",
        token: suppliedToken,
        connectionId,
      }],
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfigPath = path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json");
    const serializedConfig = await fs.readFile(runtimeConfigPath, "utf8");
    const runtimeConfig = JSON.parse(serializedConfig) as {
      mcp: Record<string, Record<string, unknown>>;
      theme: string;
    };
    expect(runtimeConfig.theme).toBe("system");
    expect(runtimeConfig.mcp[collidedName]).toEqual({ type: "local", command: ["user-owned-server"] });
    expect(runtimeConfig.mcp.other).toEqual({ type: "remote", url: "https://user.example/mcp", enabled: true });
    expect(runtimeConfig.mcp[assignedName]).toMatchObject({
      type: "remote",
      url: "https://paperclip.example/mcp/gateways/run-scoped",
      enabled: true,
      oauth: false,
      timeout: 30_000,
      headers: { Authorization: `Bearer ${suppliedToken}` },
    });
    expect(assignedName.length).toBeLessThanOrEqual(22);
    expect(serializedConfig).toContain(`Bearer ${suppliedToken}`);
    expect(prepared.notes.join("\n")).not.toContain(suppliedToken);
    expect(Object.keys(prepared.env).filter((key) => key.startsWith("PAPERCLIP_OPENCODE_MCP_TOKEN_"))).toEqual([]);
    if (process.platform !== "win32") {
      expect((await fs.stat(prepared.env.XDG_CONFIG_HOME)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(runtimeConfigPath)).mode & 0o777).toBe(0o600);
    }

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
    await expect(fs.access(prepared.env.XDG_CONFIG_HOME)).rejects.toThrow();
  });

  it("replaces a copied config symlink without modifying its user-owned target", async () => {
    const configHome = await makeConfigHome();
    const sourceTarget = path.join(configHome, "user-owned.json");
    const original = '{"theme":"user-owned","permission":{"bash":"deny"}}\n';
    await fs.writeFile(sourceTarget, original, "utf8");
    await fs.rm(path.join(configHome, "opencode", "opencode.json"), { force: true });
    await fs.symlink(sourceTarget, path.join(configHome, "opencode", "opencode.json"));

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
      runtimeMcp: [{
        name: "assigned",
        url: "https://paperclip.example/mcp",
        token: "fixture-token",
        connectionId: "fixture-connection",
      }],
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfigPath = path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json");
    expect((await fs.lstat(runtimeConfigPath)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(sourceTarget, "utf8")).toBe(original);
    expect(JSON.parse(await fs.readFile(runtimeConfigPath, "utf8"))).toMatchObject({
      theme: "user-owned",
      permission: "allow",
    });
    if (process.platform !== "win32") {
      expect((await fs.stat(path.dirname(runtimeConfigPath))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(runtimeConfigPath)).mode & 0o777).toBe(0o600);
    }
    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });

  it("merges the assigned MCP server without changing explicit permission policy", async () => {
    const configHome = await makeConfigHome({ permission: { bash: "deny" }, theme: "system" });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { dangerouslySkipPermissions: false },
      runtimeMcp: [{
        name: "Paperclip assigned",
        url: "http://paperclip.example/mcp",
        token: "fixture-token",
        connectionId: "fixture-connection",
      }],
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.permission).toEqual({ bash: "deny" });
    expect(runtimeConfig.theme).toBe("system");
    expect(runtimeConfig.mcp).toBeDefined();
    expect(prepared.notes).toEqual([expect.stringContaining("1 Paperclip-managed MCP server")]);
    await prepared.cleanup();
  });

  it("removes its private config directory if assigned MCP configuration fails", async () => {
    const configHome = await makeConfigHome({ mcp: "keep-this-invalid-user-value" });
    const mkdtemp = vi.spyOn(fs, "mkdtemp");
    try {
      await expect(prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: {},
        runtimeMcp: [{
          name: "Paperclip assigned",
          url: "https://paperclip.example/mcp",
          token: "fixture-token",
          connectionId: "fixture-connection",
        }],
      })).rejects.toThrow("OpenCode MCP configuration must be an object");
      const tempDirectory = await mkdtemp.mock.results.at(-1)!.value;
      await expect(fs.access(tempDirectory)).rejects.toThrow();
    } finally {
      mkdtemp.mockRestore();
    }
  });

  it("merges custom providers from PAPERCLIP_OPENCODE_PROVIDERS into the config", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = {
      bifrost: {
        npm: "@ai-sdk/openai-compatible",
        name: "Bifrost EU",
        options: {
          baseURL: "http://gateway.example.svc.cluster.local:8080/v1",
          apiKey: "{env:ANTHROPIC_API_KEY}",
        },
        models: { "example/model-a": { name: "Model A" } },
      },
    };

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers),
      },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig).toMatchObject({
      permission: "allow",
      provider: providers,
    });
    expect(prepared.notes.some((n) => n.includes("bifrost"))).toBe(true);
    await prepared.cleanup();
  });

  it("reads PAPERCLIP_OPENCODE_PROVIDERS from process.env when absent from the run env", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = { bifrost: { npm: "@ai-sdk/openai-compatible", models: { "example/model-a": {} } } };
    process.env.PAPERCLIP_OPENCODE_PROVIDERS = JSON.stringify(providers);
    try {
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: {},
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
      const runtimeConfig = JSON.parse(
        await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(runtimeConfig).toMatchObject({ provider: providers });
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_OPENCODE_PROVIDERS;
    }
  });

  it("expands {env:VAR} placeholders in custom providers using the run/process env (bakes the literal vk)", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = {
      bifrost: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://bifrost/v1", apiKey: "{env:ANTHROPIC_API_KEY}" },
        models: { "example/model-a": {} },
      },
    };
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers), ANTHROPIC_API_KEY: "sk-bf-REALVK" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider: { bifrost: { options: { apiKey: string } } } };
    // The {env:...} placeholder must be replaced with the literal value, so OpenCode
    // does not depend on its sandboxed process env carrying the key.
    expect(runtimeConfig.provider.bifrost.options.apiKey).toBe("sk-bf-REALVK");
    await prepared.cleanup();
  });

  it("leaves an unresolvable {env:VAR} placeholder intact", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = { bifrost: { options: { apiKey: "{env:DEFINITELY_UNSET_VAR_XYZ}" }, models: { "x/y": {} } } };
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers) },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider: { bifrost: { options: { apiKey: string } } } };
    expect(runtimeConfig.provider.bifrost.options.apiKey).toBe("{env:DEFINITELY_UNSET_VAR_XYZ}");
    await prepared.cleanup();
  });

  it("pins small_model from PAPERCLIP_OPENCODE_SMALL_MODEL", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_SMALL_MODEL: "example/model-a" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { small_model?: string };
    expect(runtimeConfig.small_model).toBe("example/model-a");
    await prepared.cleanup();
  });

  it("ignores malformed PAPERCLIP_OPENCODE_PROVIDERS without writing a provider block and surfaces a note", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: "not json" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.provider).toBeUndefined();
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS contains invalid JSON; custom providers ignored.",
    );
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_OPENCODE_PROVIDERS is valid JSON but not an object", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: "[1,2,3]" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.provider).toBeUndefined();
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    );
    await prepared.cleanup();
  });

  it("surfaces skipped provider entries with non-object values and keeps the usable ones", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
          bifrost: "http://gateway.example/v1",
          usable: { options: { baseURL: "http://gateway.example/v1" } },
        }),
      },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider?: Record<string, unknown> };
    expect(runtimeConfig.provider?.usable).toBeDefined();
    expect(runtimeConfig.provider?.bifrost).toBeUndefined();
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: bifrost.",
    );
    await prepared.cleanup();
  });

  it("surfaces skipped provider entries when no usable entries remain", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({ bifrost: "http://gateway.example/v1" }),
      },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.provider).toBeUndefined();
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: bifrost.",
    );
    await prepared.cleanup();
  });

  it("registers a configured model missing from the catalog on its provider", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { model: "openrouter/openai/gpt-oss-120b:nitro" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider?: Record<string, { models?: Record<string, unknown> }> };
    expect(runtimeConfig.provider?.openrouter?.models).toEqual({
      "openai/gpt-oss-120b:nitro": {},
    });
    expect(prepared.notes).toContain(
      "Registered configured model openrouter/openai/gpt-oss-120b:nitro in the runtime OpenCode config.",
    );
    await prepared.cleanup();
  });

  it("does not clobber an explicit model definition when registering the configured model", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = {
      openrouter: {
        models: {
          "openai/gpt-oss-120b:nitro": { name: "GPT-OSS 120B (nitro)" },
          "example/other": {},
        },
      },
    };
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers),
      },
      config: { model: "openrouter/openai/gpt-oss-120b:nitro" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { provider?: Record<string, { models?: Record<string, unknown> }> };
    expect(runtimeConfig.provider?.openrouter?.models).toEqual(providers.openrouter.models);
    expect(
      prepared.notes.some((note) => note.startsWith("Registered configured model")),
    ).toBe(false);
    await prepared.cleanup();
  });

  it("skips model registration when the configured model is not provider/model shaped", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { model: "not-a-provider-model" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.provider).toBeUndefined();
    await prepared.cleanup();
  });

  it("respects explicit opt-out", async () => {
    const configHome = await makeConfigHome();
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { dangerouslySkipPermissions: false },
    });

    expect(prepared.env).toEqual({ XDG_CONFIG_HOME: configHome });
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });

  it.each([false, true])("adds run-scoped MCP servers without changing permission policy (skip=%s)", async (skip) => {
    const configHome = await makeConfigHome({
      permission: { bash: "ask", "mcp__existing__write": "deny" },
      mcp: {
        "paperclip-assigned": { type: "remote", url: "https://user.example/mcp", enabled: true },
        existing: { type: "remote", url: "https://existing.example/mcp", enabled: true },
      },
      provider: { custom: { models: { "example/model": {} } } },
      small_model: "example/model",
    });
    const token = "run-scoped-fixture-secret";
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { dangerouslySkipPermissions: skip },
      runtimeMcp: [
        { name: "paperclip-assigned", connectionId: `assignment:${"a".repeat(64)}`, url: "https://paperclip.example/mcp/one", token },
        { name: "paperclip-assigned", connectionId: `assignment:${"b".repeat(64)}`, url: "https://paperclip.example/mcp/two", token: "second-run-token" },
      ],
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfigPath = path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json");
    const runtimeConfig = JSON.parse(await fs.readFile(runtimeConfigPath, "utf8")) as {
      mcp: Record<string, unknown>;
      permission?: unknown;
      provider?: unknown;
      small_model?: unknown;
    };
    expect(runtimeConfig.mcp).toMatchObject({
      "paperclip-assigned": { url: "https://user.example/mcp" },
      existing: { url: "https://existing.example/mcp" },
    });
    const assignedEntries = Object.entries(runtimeConfig.mcp).filter(([, server]) =>
      typeof server === "object" && server !== null && "url" in server &&
      (server.url === "https://paperclip.example/mcp/one" || server.url === "https://paperclip.example/mcp/two"),
    );
    expect(assignedEntries).toHaveLength(2);
    const firstServer = assignedEntries.find(([, server]) =>
      typeof server === "object" && server !== null && "url" in server && server.url === "https://paperclip.example/mcp/one",
    );
    const secondServer = assignedEntries.find(([, server]) =>
      typeof server === "object" && server !== null && "url" in server && server.url === "https://paperclip.example/mcp/two",
    );
    expect(firstServer?.[1]).toMatchObject({
      type: "remote", enabled: true, oauth: false, timeout: 30_000,
      url: "https://paperclip.example/mcp/one",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(secondServer?.[1]).toMatchObject({
      type: "remote", url: "https://paperclip.example/mcp/two",
      headers: { Authorization: "Bearer second-run-token" },
    });
    const generatedNames = assignedEntries.map(([name]) => name);
    expect(generatedNames.every((name) => /^paperclip_[A-F0-9]{12}$/.test(name))).toBe(true);
    const gatewayMetaActionNames = [
      `mcp.app-gallery-files:${"read_sensitive_metadata".padEnd(103 - "mcp.app-gallery-files:".length, "x")}`,
      `mcp.app-gallery-files:${"update_sensitive_metadata".padEnd(104 - "mcp.app-gallery-files:".length, "y")}`,
    ];
    const composedToolNames = generatedNames.flatMap((serverName) =>
      gatewayMetaActionNames.map((toolName) => `${serverName}__${toolName}`),
    );
    expect(gatewayMetaActionNames.map((name) => name.length)).toEqual([103, 104]);
    expect(generatedNames.every((name) => name.length <= 22)).toBe(true);
    expect(composedToolNames.every((name) => name.length <= 128)).toBe(true);
    expect(new Set(composedToolNames).size).toBe(composedToolNames.length);
    expect(JSON.stringify(runtimeConfig.mcp)).not.toContain("a".repeat(64));
    expect(JSON.stringify(runtimeConfig.mcp)).not.toContain("b".repeat(64));
    expect(runtimeConfig.permission).toEqual(skip ? "allow" : { bash: "ask", "mcp__existing__write": "deny" });
    expect(runtimeConfig.provider).toEqual({ custom: { models: { "example/model": {} } } });
    expect(runtimeConfig.small_model).toBe("example/model");
    if (process.platform !== "win32") {
      expect((await fs.stat(runtimeConfigPath)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.stringify(prepared.notes)).not.toContain(token);
    expect(JSON.parse(await fs.readFile(path.join(configHome, "opencode", "opencode.json"), "utf8"))).toMatchObject({
      permission: { bash: "ask" },
      mcp: { "paperclip-assigned": { url: "https://user.example/mcp" } },
    });

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
    await expect(fs.access(prepared.env.XDG_CONFIG_HOME)).rejects.toThrow();
  });


  it("injects run-scoped MCP servers into an isolated remote runtime config", async () => {
    const configHome = await makeConfigHome({
      theme: "host-only-theme",
      permission: { bash: "deny" },
      mcp: { hostOnly: { type: "remote", url: "https://host.example/mcp", headers: { Authorization: "Bearer host-only-secret" } } },
    });
    const token = "remote-run-scoped-fixture-secret";
    const url = "https://paperclip.example/api/mcp/remote-run";
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { dangerouslySkipPermissions: false },
      runtimeMcp: [{ name: "Assigned remote tools", connectionId: "remote-run-assignment", url, token }],
      targetIsRemote: true,
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfigPath = path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json");
    const runtimeConfig = JSON.parse(await fs.readFile(runtimeConfigPath, "utf8")) as {
      mcp: Record<string, unknown>;
      permission?: unknown;
      theme?: unknown;
    };
    const assigned = Object.entries(runtimeConfig.mcp).find(([, server]) =>
      typeof server === "object" && server !== null && "url" in server && server.url === url,
    );
    expect(assigned).toBeDefined();
    expect(assigned?.[0]).toMatch(/^paperclip_[A-F0-9]{12}$/);
    expect(assigned?.[1]).toMatchObject({
      type: "remote",
      url,
      enabled: true,
      oauth: false,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(Object.keys(runtimeConfig.mcp)).toEqual([assigned?.[0]]);
    expect(runtimeConfig.permission).toBeUndefined();
    expect(runtimeConfig.theme).toBeUndefined();
    expect(JSON.stringify(runtimeConfig)).not.toContain("host-only-secret");
    expect(JSON.stringify(prepared.notes)).not.toContain(token);
    expect(prepared.taskToolsPath).toBeUndefined();
    if (process.platform !== "win32") {
      expect((await fs.stat(runtimeConfigPath)).mode & 0o777).toBe(0o600);
    }

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
    await expect(fs.access(prepared.env.XDG_CONFIG_HOME)).rejects.toThrow();
  });

  it("keeps a readable short label and deterministically bounds long labels", async () => {
    const configHome = await makeConfigHome();
    const servers = [{
      name: "Paperclip project tools with a long descriptive label",
      connectionId: `assignment:${"c".repeat(64)}`,
      url: "https://paperclip.example/mcp",
      token: "fixture-token",
    }];
    const first = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { dangerouslySkipPermissions: false },
      runtimeMcp: servers,
    });
    cleanupPaths.add(first.env.XDG_CONFIG_HOME);
    const firstConfig = JSON.parse(
      await fs.readFile(path.join(first.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { mcp: Record<string, unknown> };
    const [firstName] = Object.keys(firstConfig.mcp);
    expect(firstName).toMatch(/^paperclip_[A-F0-9]{12}$/);
    expect(firstName.length).toBeLessThanOrEqual(22);

    await first.cleanup();
    cleanupPaths.delete(first.env.XDG_CONFIG_HOME);
    const second = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { dangerouslySkipPermissions: false },
      runtimeMcp: servers,
    });
    cleanupPaths.add(second.env.XDG_CONFIG_HOME);
    const secondConfig = JSON.parse(
      await fs.readFile(path.join(second.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { mcp: Record<string, unknown> };
    expect(Object.keys(secondConfig.mcp)).toEqual([firstName]);
    await second.cleanup();
    cleanupPaths.delete(second.env.XDG_CONFIG_HOME);
  });

  it("does not follow a user config symlink when writing the run secret", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-symlink-test-"));
    cleanupPaths.add(root);
    const configHome = path.join(root, "config");
    const externalConfig = path.join(root, "external.json");
    const configDir = path.join(configHome, "opencode");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(externalConfig, JSON.stringify({ theme: "system" }), "utf8");
    await fs.symlink(externalConfig, path.join(configDir, "opencode.json"));

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { dangerouslySkipPermissions: false },
      runtimeMcp: [{
        name: "Assigned tools",
        connectionId: "connection-1",
        url: "https://paperclip.example/mcp",
        token: "fixture-secret",
      }],
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfigPath = path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json");
    expect((await fs.lstat(runtimeConfigPath)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(externalConfig, "utf8")).toBe(JSON.stringify({ theme: "system" }));
    if (process.platform !== "win32") {
      expect((await fs.stat(runtimeConfigPath)).mode & 0o777).toBe(0o600);
    }
    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });
});
