import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanups.splice(0).map((fn) => fn())); });

async function makeHooks() {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-stream-test-"));
  cleanups.push(() => fs.rm(source, { recursive: true, force: true }));
  await fs.mkdir(path.join(source, "opencode"));
  await fs.writeFile(path.join(source, "opencode/opencode.json"), JSON.stringify({ provider: { paperclip: {
    npm: "@ai-sdk/openai-compatible", options: { apiKey: "fixture-secret-do-not-log" },
    models: { simple: { options: { timeout: 35 } } },
  } } }));
  const prepared = await prepareOpenCodeRuntimeConfig({ env: { XDG_CONFIG_HOME: source }, config: { model: "paperclip/simple" } });
  cleanups.push(prepared.cleanup);
  const plugins = path.join(prepared.env.XDG_CONFIG_HOME, "opencode/plugins");
  const file = (await fs.readdir(plugins)).find((name) => name.startsWith("paperclip-model-timeout-"))!;
  const { PaperclipModelStepTimeout } = await import(pathToFileURL(path.join(plugins, file)).href);
  return PaperclipModelStepTimeout();
}

it.each([false, true])("settles a completed SSE stream before HTTP EOF (tool=%s), without retry or waiting for cancellation", async (tool) => {
  const hooks = await makeHooks();
  const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
  const cancelled = vi.fn(() => new Promise<void>(() => {}));
  const delta = tool ? { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "write", arguments: "{}" } }] } : { content: "OK" };
  const event = `data: ${JSON.stringify({ choices: [{ delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\r\n\r\n`;
  const fetch = vi.fn(async () => new Response(new ReadableStream({
    start(controller) {
      for (const text of [event, "data: [DO", "NE]\r\n\r", "\n"]) controller.enqueue(new TextEncoder().encode(text));
    },
    cancel: cancelled,
  }), { headers: { "content-type": "text/event-stream" } }));
  const auth = await hooks.auth.loader(null, { options: { fetch } });
  const response = await auth.fetch("https://fixture.invalid/v1/chat/completions", { body: JSON.stringify({ model: "simple" }) });
  expect(await response.text()).toBe(event + "data: [DONE]\r\n\r\n");
  await new Promise((resolve) => setTimeout(resolve, 55));
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(diagnostics).not.toHaveBeenCalled();
});

it("reports bounded timeout facts and never retries a complete or uncertain tool call", async () => {
  const hooks = await makeHooks();
  const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
  let payload = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: null }] })}\n\n`;
  const fetch = vi.fn(async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
    },
  }), { headers: { "content-type": "text/event-stream" } }));
  const auth = await hooks.auth.loader(null, { options: { fetch } });
  const request = async () => (await auth.fetch("https://fixture.invalid/secret", { body: JSON.stringify({ model: "simple", messages: ["secret-prompt"] }) })).text();
  await expect(request()).rejects.toMatchObject({ message: "response timeout" });
  payload = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "x", function: { name: "write", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`;
  await expect(request()).rejects.toMatchObject({ message: "OpenCode model step timed out" });
  payload = "data: {\"unknown\":true}\n\n";
  await expect(request()).rejects.toMatchObject({ message: "OpenCode model step timed out" });
  payload = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: null }] })}\n\n`;
  await expect(request()).rejects.toMatchObject({ message: "response timeout" });
  await expect(request()).rejects.toMatchObject({ message: "OpenCode model step timed out" });
  const facts = diagnostics.mock.calls.map(([line]) => JSON.parse(String(line).split("model-step-timeout ")[1]));
  expect(facts).toMatchObject([{ retry: true, retriesUsed: 0 }, { retry: false, completeTool: true }, { retry: false, parserUncertain: true },
    { retry: true, retriesUsed: 1 }, { retry: false, retriesUsed: 2, retryBudget: 2 }]);
  expect(JSON.stringify(diagnostics.mock.calls)).not.toMatch(/secret|fixture\.invalid|write|call-1/);
});
