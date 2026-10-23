import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { isOpenRouterUrl, openRouterAttributionHeaders } from "@paperclipai/adapter-utils/openrouter-attribution";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";
import { PAPERCLIP_TASK_TOOLS_SOURCE } from "./task-tools.js";

const MAX_RUNTIME_MCP_SERVER_NAME_LENGTH = 22;

type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  runtimeConfigHome: string | null;
  taskToolsPath?: string;
  cleanup: () => Promise<void>;
};

function resolveXdgConfigHome(env: Record<string, string>): string {
  return (
    (typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()) ||
    (typeof process.env.XDG_CONFIG_HOME === "string" && process.env.XDG_CONFIG_HOME.trim()) ||
    path.join(os.homedir(), ".config")
  );
}

function resolveXdgDataHome(env: Record<string, string>): string {
  return (
    (typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.trim()) ||
    (typeof process.env.XDG_DATA_HOME === "string" && process.env.XDG_DATA_HOME.trim()) ||
    (process.platform === "win32" && process.env.APPDATA
      ? process.env.APPDATA
      : path.join(os.homedir(), process.platform === "darwin" ? "Library/Application Support" : ".local/share"))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStaticApiAuth(value: unknown): value is { type: "api"; key: string } {
  return isPlainObject(value) && value.type === "api" && typeof value.key === "string" && value.key.length > 0;
}

function isValidStoredAuth(value: unknown): boolean {
  if (isStaticApiAuth(value)) return true;
  if (!isPlainObject(value)) return false;
  if (value.type === "wellknown") return typeof value.key === "string" && typeof value.token === "string";
  return value.type === "oauth" && typeof value.access === "string" && typeof value.refresh === "string" && Number.isFinite(value.expires);
}

// Recursively replace {env:VAR} placeholders with the resolved value. Used to bake
// gateway provider secrets (e.g. the LLM-gateway virtual key) into opencode.json
// SERVER-SIDE, where the value is reliably present. OpenCode's own {env:...}
// resolution happens inside the (possibly sandboxed) run process, whose env
// plumbing is not guaranteed to carry the key to OpenCode's spawned server -- so
// we resolve it here. Unresolvable placeholders are left intact for OpenCode to try.
function expandEnvPlaceholders<T>(value: T, resolve: (name: string) => string | undefined): T {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      const resolved = resolve(name);
      return resolved !== undefined && resolved.length > 0 ? resolved : match;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandEnvPlaceholders(entry, resolve)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = expandEnvPlaceholders(entry, resolve);
    }
    return out as unknown as T;
  }
  return value;
}

function parseProviderConfig(
  raw: unknown,
  resolveEnv: (name: string) => string | undefined,
  notes: string[],
): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Surface the misconfiguration instead of silently dropping the provider
    // block; an unparseable value would otherwise be undiagnosable.
    notes.push("PAPERCLIP_OPENCODE_PROVIDERS contains invalid JSON; custom providers ignored.");
    return null;
  }
  if (!isPlainObject(parsed)) {
    notes.push(
      "PAPERCLIP_OPENCODE_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    );
    return null;
  }
  // Only keep provider entries that are themselves objects; surface the ones
  // we drop so a malformed entry is just as diagnosable as malformed JSON.
  const providers: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (isPlainObject(value)) providers[key] = expandEnvPlaceholders(value, resolveEnv);
    else skipped.push(key);
  }
  if (skipped.length > 0) {
    notes.push(
      `PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: ${skipped.join(", ")}.`,
    );
  }
  return Object.keys(providers).length > 0 ? providers : null;
}

async function readJsonObject(filepath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filepath, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildRuntimeMcpConfig(
  existing: Record<string, unknown>,
  servers: readonly AdapterRuntimeMcpServer[],
): Record<string, unknown> {
  const mcp: Record<string, unknown> = { ...existing };
  const usedNames = new Set(Object.keys(mcp));
  for (const server of servers) {
    let endpoint: URL;
    try {
      endpoint = new URL(server.url);
    } catch {
      throw new Error("A Paperclip runtime MCP server has an invalid URL.");
    }
    if (!(endpoint.protocol === "http:" || endpoint.protocol === "https:") || endpoint.username || endpoint.password ||
        !server.connectionId.trim() || !server.token.trim() || /[\r\n]/.test(server.token)) {
      throw new Error("A Paperclip runtime MCP server has an invalid HTTP binding.");
    }
    const safeServerName = server.name.replace(/[^a-zA-Z0-9_-]/g, "_") || "connection";
    let suffix = 1;
    let name: string;
    do {
      const collisionSuffix = suffix === 1 ? "" : `_${suffix}`;
      const nameBudget = MAX_RUNTIME_MCP_SERVER_NAME_LENGTH - collisionSuffix.length;
      if (safeServerName.length <= nameBudget) {
        name = `${safeServerName}${collisionSuffix}`;
      } else {
        const hash = createHash("sha256").update(safeServerName).digest("hex").slice(0, 8);
        const prefixLength = nameBudget - hash.length - 1;
        name = `${safeServerName.slice(0, prefixLength)}_${hash}${collisionSuffix}`;
      }
      suffix += 1;
    } while (usedNames.has(name));
    usedNames.add(name);
    mcp[name] = {
      type: "remote",
      url: server.url,
      headers: { Authorization: `Bearer ${server.token}` },
      enabled: true,
      oauth: false,
      timeout: 30_000,
    };
  }
  return mcp;
}

async function ensurePrivatePluginDirectory(pluginDir: string): Promise<void> {
  try {
    const stat = await fs.lstat(pluginDir);
    if (stat.isSymbolicLink()) {
      // Do not silently discard user plugins from an external target. Copying
      // them safely requires resolving a user-managed tree, so fail this
      // optional feature closed and leave normal OpenCode startup untouched.
      throw new Error("OpenCode plugin path is a symlink; refusing to replace user plugins");
    } else if (!stat.isDirectory()) {
      throw new Error("OpenCode plugin path is not a directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  }
  await fs.mkdir(pluginDir, { recursive: true, mode: 0o700 });
  await fs.chmod(pluginDir, 0o700);
  if ((await fs.readdir(pluginDir)).length > 0) {
    throw new Error("OpenCode plugin hooks may already define provider fetch behavior");
  }
}

const DEFAULT_OPEN_CODE_MODEL_TIMEOUT_MS = 300_000;
const MAX_NODE_TIMEOUT_MS = 2_147_483_647;
const MAX_OPEN_CODE_TIMEOUT_RETRIES = 2;

function configuredModelRef(raw: unknown): { provider: string; model: string } | null {
  if (typeof raw !== "string") return null;
  const separator = raw.indexOf("/");
  if (separator <= 0 || separator === raw.length - 1) return null;
  return { provider: raw.slice(0, separator).trim(), model: raw.slice(separator + 1).trim() };
}

function parseConfigContent(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveConfiguredSecret(raw: unknown, env: Record<string, string>): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const resolved = expandEnvPlaceholders(raw, (name) => env[name] ?? process.env[name]);
  if (typeof resolved !== "string" || resolved.trim().length === 0 || /\{env:[A-Za-z_][A-Za-z0-9_]*\}/.test(resolved)) {
    return null;
  }
  return resolved;
}

function buildOpenCodeTimeoutPlugin(providerName: string, targetModels: string[], timeoutMs: number, retryBudget: number): string {
  const providerLiteral = JSON.stringify(providerName);
  const targetModelsLiteral = JSON.stringify(targetModels);
  const timeoutLiteral = JSON.stringify(timeoutMs);
  const retryBudgetLiteral = JSON.stringify(retryBudget);
  return `import { randomUUID } from "node:crypto";

const providerName = ${providerLiteral};
const targetModels = new Set(${targetModelsLiteral});
const timeoutMs = ${timeoutLiteral};
const retryBudget = ${retryBudgetLiteral};
const MAX_PENDING_CHARS = 1_048_576;
const MAX_TOOL_ARGUMENT_CHARS = 1_048_576;
export const PaperclipModelStepTimeout = async () => {
  let dispatchCount = 0;
  let normalizedTimeoutRetries = 0;
  const activeFetches = new Set();
  return {
    auth: {
      provider: providerName,
      methods: [{ type: "api", label: "Configured provider" }],
      loader: async (_getAuth, providerInfo) => {
        const configuredFetch = providerInfo?.options?.fetch;
        const baseFetch = typeof configuredFetch === "function" ? configuredFetch : (...args) => fetch(...args);
        return {
        fetch: async (url, init = {}) => {
          const requestBody = (() => {
            try {
              const raw = typeof init?.body === "string" ? init.body : "";
              return raw ? JSON.parse(raw) : null;
            } catch { return null; }
          })();
          const isTargetModel = Boolean(requestBody && typeof requestBody.model === "string" && targetModels.has(requestBody.model));
          const externalSignal = init?.signal;
          const request = { baseline: dispatchCount, isTargetModel, timedOut: false, canNormalizeTimeout: false, sawCompleteTool: false, parserUncertain: false, overlap: false, active: true };
          if (activeFetches.size > 0) {
            request.overlap = true;
            for (const active of activeFetches) active.overlap = true;
          }
          activeFetches.add(request);
          const finish = () => {
            if (!request.active) return;
            request.active = false;
            activeFetches.delete(request);
          };
          const mayRetry = () => request.timedOut
            && !externalSignal?.aborted
            && request.isTargetModel
            && request.canNormalizeTimeout
            && dispatchCount === request.baseline
            && !request.sawCompleteTool
            && !request.parserUncertain
            && !request.overlap
            && activeFetches.size === 1;
          const mapTimeout = (error) => {
            if (!request.timedOut || externalSignal?.aborted) return error;
            const retry = mayRetry() && normalizedTimeoutRetries < retryBudget;
            // Only bounded protocol facts: never log prompts, arguments, URLs or credentials.
            console.error("[paperclip] model-step-timeout " + JSON.stringify({
              retry, retriesUsed: normalizedTimeoutRetries, retryBudget,
              sse: request.canNormalizeTimeout, completeTool: request.sawCompleteTool,
              parserUncertain: request.parserUncertain, overlap: request.overlap,
              dispatched: dispatchCount !== request.baseline,
            }));
            if (!retry) return error;
            normalizedTimeoutRetries += 1;
            return new Error("response timeout", { cause: error });
          };

          let response;
          const deadlineController = new AbortController();
          const signal = externalSignal ? AbortSignal.any([externalSignal, deadlineController.signal]) : deadlineController.signal;
          const deadline = request.isTargetModel ? setTimeout(() => {
            request.timedOut = true;
            deadlineController.abort(new DOMException("OpenCode model step timed out", "TimeoutError"));
          }, timeoutMs) : null;
          const finishDeadline = () => { if (deadline !== null) clearTimeout(deadline); };
          try {
            response = await baseFetch(url, { ...init, signal });
          } catch (error) {
            const mappedError = mapTimeout(error);
            finishDeadline();
            finish();
            throw mappedError;
          }
          const isSse = response.status >= 200 && response.status < 300
            && (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
          request.canNormalizeTimeout = isSse;
          if (!response.body) {
            finishDeadline();
            finish();
            return response;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let pending = "";
          let streamDone = false;
          const calls = new Map();
          const inspectFrame = (frame) => {
            const lines = frame.split(/\\r?\\n/);
            if (lines.some((line) => line && !line.startsWith(":") && !line.startsWith("data:") && !line.startsWith("event:") && !line.startsWith("id:") && !line.startsWith("retry:"))) {
              request.parserUncertain = true;
              return;
            }
            const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\\n");
            if (!data) return;
            if (data === "[DONE]") { streamDone = true; return; }
            let event;
            try { event = JSON.parse(data); } catch { request.parserUncertain = true; return; }
            if (!event || typeof event !== "object" || !Array.isArray(event.choices)) {
              request.parserUncertain = true;
              return;
            }
            if (event.choices.length === 0 && (!event.usage || typeof event.usage !== "object")) request.parserUncertain = true;
            for (const choice of event.choices ?? []) {
              if (!choice || typeof choice !== "object") { request.parserUncertain = true; continue; }
              if (choice.finish_reason === "function_call" || choice.delta?.function_call || choice.message?.function_call) {
                request.parserUncertain = true;
              }
              if (choice.finish_reason === "tool_calls") request.sawCompleteTool = true;
              if (choice.finish_reason !== null && choice.finish_reason !== undefined && !["stop", "length", "content_filter", "tool_calls"].includes(choice.finish_reason)) request.parserUncertain = true;
              const toolCalls = choice.delta?.tool_calls ?? choice.message?.tool_calls ?? [];
              if (!Array.isArray(toolCalls)) { request.parserUncertain = true; continue; }
              for (const part of toolCalls) {
                if (!part || typeof part !== "object") { request.parserUncertain = true; continue; }
                const index = Number.isInteger(part.index) ? part.index : 0;
                const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
                if (typeof part.id === "string") call.id = (call.id + part.id).slice(0, 512);
                const fn = part.function ?? {};
                if (typeof part.type === "string" && part.type !== "function") request.parserUncertain = true;
                if (typeof fn.name === "string") call.name = (call.name + fn.name).slice(0, 512);
                if (typeof fn.arguments === "string") {
                  if (call.arguments.length + fn.arguments.length > MAX_TOOL_ARGUMENT_CHARS) request.parserUncertain = true;
                  else call.arguments += fn.arguments;
                }
                calls.set(index, call);
                if (call.id && call.name && call.arguments.length > 0) {
                  try { JSON.parse(call.arguments); request.sawCompleteTool = true; } catch {
                    // Incomplete arguments are expected while streaming, but
                    // parser errors cannot prove that a complete call is absent.
                    request.parserUncertain = true;
                  }
                }
              }
            }
          };
          const inspectChunk = (bytes, final = false) => {
            pending += decoder.decode(bytes, { stream: !final });
            if (pending.length > MAX_PENDING_CHARS) {
              request.parserUncertain = true;
              pending = "";
              return;
            }
            const frames = pending.split(/\\r?\\n\\r?\\n/);
            pending = frames.pop() ?? "";
            for (const frame of frames) {
              inspectFrame(frame);
              if (streamDone) break;
            }
            if (final && pending.trim()) inspectFrame(pending);
          };
          const body = new ReadableStream({
            async pull(controller) {
              try {
                const item = await reader.read();
                if (item.done) {
                  if (isSse) inspectChunk(new Uint8Array(), true);
                  finishDeadline();
                  finish();
                  controller.close();
                } else {
                  if (isSse) inspectChunk(item.value);
                  controller.enqueue(item.value);
                  if (streamDone) {
                    // SSE completion is independent of HTTP EOF. Some proxies
                    // keep the transport alive after the terminal marker.
                    finishDeadline();
                    finish();
                    controller.close();
                    void reader.cancel().catch(() => {});
                  }
                }
              } catch (error) {
                // A complete call may arrive in the last chunk without the
                // normal blank-line delimiter. Parse buffered bytes before
                // deciding whether retrying the model step is safe.
                if (request.timedOut && isSse) inspectChunk(new Uint8Array(), true);
                const mappedError = mapTimeout(error);
                finishDeadline();
                finish();
                controller.error(mappedError);
              }
            },
            async cancel(reason) {
              try { await reader.cancel(reason); } finally { finishDeadline(); finish(); }
            },
          });
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        },
      };
      },
    },
    "tool.execute.before": async () => { dispatchCount += 1; },
  };
};
`;
}

export async function prepareOpenCodeRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  runtimeMcp?: AdapterRuntimeMcpServer[];
  runtimeMcpServers?: readonly AdapterRuntimeMcpServer[];
  targetIsRemote?: boolean;
}): Promise<PreparedOpenCodeRuntimeConfig> {
  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, true);
  const targetIsRemote = input.targetIsRemote === true;
  const runtimeMcpServers = input.runtimeMcp ?? input.runtimeMcpServers ?? [];
  const selectedModel = configuredModelRef(input.config.model);
  if (!skipPermissions && runtimeMcpServers.length === 0 && (!selectedModel || targetIsRemote)) {
    return {
      env: input.env,
      notes: [],
      runtimeConfigHome: null,
      cleanup: async () => {},
    };
  }
  const sourceConfigDir = input.targetIsRemote ? null : path.join(resolveXdgConfigHome(input.env), "opencode");
  const runtimeConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-config-"));
  const runtimeConfigDir = path.join(runtimeConfigHome, "opencode");
  const runtimeConfigPath = path.join(runtimeConfigDir, "opencode.json");

  try {
    await fs.mkdir(runtimeConfigDir, { recursive: true, mode: 0o700 });
    await fs.chmod(runtimeConfigHome, 0o700);
    await fs.chmod(runtimeConfigDir, 0o700);
    try {
      if (sourceConfigDir) await fs.cp(sourceConfigDir, runtimeConfigDir, {
        recursive: true,
        force: true,
        errorOnExist: false,
        dereference: false,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
        throw err;
      }
    }
    // Copying the user's config may restore looser directory permissions.
    // The runtime copy can contain assigned MCP credentials, so reassert them.
    await fs.chmod(runtimeConfigHome, 0o700);
    await fs.chmod(runtimeConfigDir, 0o700);

    const existingConfig = await readJsonObject(runtimeConfigPath);
    const envConfigContentRaw = input.env.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT;
    const envConfigContent = parseConfigContent(envConfigContentRaw);
    const notes = skipPermissions
      ? ["Injected runtime OpenCode config with permission=allow for all tools and connections."]
      : [];

    // Merge gateway/custom provider definitions supplied via PAPERCLIP_OPENCODE_PROVIDERS
    // (a JSON object in OpenCode's `provider` shape). OpenCode resolves a `--model
    // provider/model` only when that model exists in a provider's `models` map, and
    // OPENCODE_ALLOW_ALL_MODELS does NOT bypass its internal getModel(). So routing a
    // gateway model (e.g. an EU LLM gateway exposing OpenAI-compatible /v1) requires a
    // custom provider with an explicit models map. We accept it as config (not
    // hard-coded) so the gateway URL, key env, and model list stay declarative.
    const existingProvider = isPlainObject(existingConfig.provider) ? existingConfig.provider : {};
    let nextProvider = existingProvider;
    if (skipPermissions) {
      const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
      const gatewayProviders = parseProviderConfig(
        input.env.PAPERCLIP_OPENCODE_PROVIDERS ?? process.env.PAPERCLIP_OPENCODE_PROVIDERS,
        resolveEnv,
        notes,
      );
      nextProvider = gatewayProviders ? { ...existingProvider, ...gatewayProviders } : existingProvider;
      if (gatewayProviders) {
        notes.push(
          `Injected ${Object.keys(gatewayProviders).length} custom OpenCode provider(s) from PAPERCLIP_OPENCODE_PROVIDERS: ${Object.keys(gatewayProviders).join(", ")}.`,
        );
      }
    }

    // Register the configured model on its provider's models map. OpenCode resolves
    // `--model provider/model` only when the model id exists in that map, so ids the
    // models.dev catalog does not carry — OpenRouter routing variants such as
    // `openai/gpt-oss-120b:nitro`, or models newer than the bundled catalog — are
    // otherwise rejected with "Model not found" even though the provider serves them.
    // An empty entry deep-merges with catalog metadata, so this is a no-op for models
    // the catalog already knows, and we never clobber an explicit definition from the
    // user config or PAPERCLIP_OPENCODE_PROVIDERS.
    const configuredModel = skipPermissions ? selectedModel : null;
    if (configuredModel) {
      const providerEntry = isPlainObject(nextProvider[configuredModel.provider])
        ? { ...(nextProvider[configuredModel.provider] as Record<string, unknown>) }
        : {};
      const providerModels = isPlainObject(providerEntry.models)
        ? { ...(providerEntry.models as Record<string, unknown>) }
        : {};
      if (!isPlainObject(providerModels[configuredModel.model])) {
        providerModels[configuredModel.model] = {};
        providerEntry.models = providerModels;
        nextProvider = { ...nextProvider, [configuredModel.provider]: providerEntry };
        notes.push(
          `Registered configured model ${configuredModel.provider}/${configuredModel.model} in the runtime OpenCode config.`,
        );
      }
    }

    const inlineContent = input.env.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT;
    const inlineConfig = parseConfigContent(inlineContent);
    const inlineProvider = isPlainObject(inlineConfig?.provider) ? inlineConfig.provider : {};
    nextProvider = attributeOpenCodeProviders(mergeConfigObjects(nextProvider, inlineProvider));

    const nextConfig: Record<string, unknown> = { ...existingConfig };
    if (skipPermissions) nextConfig.permission = "allow";
    if (skipPermissions && Object.keys(nextProvider).length > 0) {
      nextConfig.provider = nextProvider;
    }

    let timeoutPluginInstalled = false;
    let timeoutAuthContent: string | undefined;
    if (!input.targetIsRemote && selectedModel) {
      const fileProvider = isPlainObject(nextProvider[selectedModel.provider])
        ? nextProvider[selectedModel.provider] as Record<string, unknown>
        : {};
      const envProviders = isPlainObject(envConfigContent?.provider) ? envConfigContent.provider : {};
      const envProvider = isPlainObject(envProviders[selectedModel.provider])
        ? envProviders[selectedModel.provider] as Record<string, unknown>
        : {};
      const effectiveProvider = { ...fileProvider, ...envProvider };
      const fileOptions = isPlainObject(fileProvider.options) ? fileProvider.options : {};
      const envOptions = isPlainObject(envProvider.options) ? envProvider.options : {};
      const effectiveOptions = { ...fileOptions, ...envOptions };
      const modelConfig: Record<string, unknown> = isPlainObject(effectiveProvider.models) && isPlainObject(effectiveProvider.models[selectedModel.model])
        ? effectiveProvider.models[selectedModel.model] as Record<string, unknown>
        : {};
      const modelOptions = isPlainObject(modelConfig.options) ? modelConfig.options : {};
      const timeoutValue = Object.hasOwn(modelOptions, "timeout") ? modelOptions.timeout : effectiveOptions.timeout;
      const maxRetriesValue = Object.hasOwn(modelOptions, "maxRetries") ? modelOptions.maxRetries : effectiveOptions.maxRetries;
      const retryBudget = maxRetriesValue === false || maxRetriesValue === 0
        ? 0
        : typeof maxRetriesValue === "number" && Number.isFinite(maxRetriesValue)
          ? Math.min(MAX_OPEN_CODE_TIMEOUT_RETRIES, Math.max(0, Math.floor(maxRetriesValue)))
          : MAX_OPEN_CODE_TIMEOUT_RETRIES;
      const hasTimeoutOptOut = timeoutValue === false || timeoutValue === 0;
      const timeoutMs = typeof timeoutValue === "number" && Number.isFinite(timeoutValue) && timeoutValue > 0
        ? timeoutValue
        : DEFAULT_OPEN_CODE_MODEL_TIMEOUT_MS;
      const timeoutSupported = timeoutMs <= MAX_NODE_TIMEOUT_MS;
      const compatibleProvider = effectiveProvider.npm === "@ai-sdk/openai-compatible";

      if (compatibleProvider && !hasTimeoutOptOut && !timeoutSupported) {
        notes.push(
          `OpenCode model-step timeout recovery was not enabled for provider ${selectedModel.provider}: the configured timeout exceeds the supported Node.js timer range.`,
        );
      } else if (compatibleProvider && !hasTimeoutOptOut) {
        const providerKey = resolveConfiguredSecret(effectiveOptions.apiKey, input.env);
        const sourceAuthPath = path.join(resolveXdgDataHome(input.env), "opencode", "auth.json");
        const sourceAuth = await readJsonObject(sourceAuthPath);
        const suppliedAuth = parseConfigContent(input.env.OPENCODE_AUTH_CONTENT ?? process.env.OPENCODE_AUTH_CONTENT);
        // Auth.all() treats a supplied record as the entire auth source, even
        // when the selected provider is absent. Do not resurrect hidden file auth.
        const storedProviderAuth = (suppliedAuth ?? sourceAuth)[selectedModel.provider];
        const authEntry = providerKey
          ? { type: "api", key: providerKey }
          : isStaticApiAuth(storedProviderAuth) ? storedProviderAuth : null;

        if (!authEntry) {
          notes.push(
            `OpenCode model-step timeout recovery was not enabled for provider ${selectedModel.provider}: no usable provider credential was available in the isolated runtime.`,
          );
        } else {
          let pluginPath: string | null = null;
          try {
            const configuredPlugins = [existingConfig.plugin, envConfigContent?.plugin].some(
              (value) => Array.isArray(value) && value.length > 0,
            );
            if (configuredPlugins) {
              throw new Error("Configured OpenCode plugins may already define provider fetch behavior");
            }
            const pluginDir = path.join(runtimeConfigDir, "plugins");
            await ensurePrivatePluginDirectory(pluginDir);
            pluginPath = path.join(pluginDir, `paperclip-model-timeout-${randomUUID()}.js`);
            const targetModelIds = [...new Set([
              selectedModel.model,
              ...(typeof modelConfig.id === "string" ? [modelConfig.id] : []),
              ...(isPlainObject(modelConfig.api) && typeof modelConfig.api.id === "string" ? [modelConfig.api.id] : []),
            ])];
            await fs.writeFile(pluginPath, buildOpenCodeTimeoutPlugin(selectedModel.provider, targetModelIds, timeoutMs, retryBudget), {
              encoding: "utf8",
              mode: 0o600,
              flag: "wx",
            });
            await fs.chmod(pluginPath, 0o600);

            // Auth.get() in OpenCode 1.18.35 reads OPENCODE_AUTH_CONTENT before
            // the normal data home. Keep the existing data home intact so
            // sessions/state remain visible. Preserve valid auth entries and
            // replace only the selected provider's entry for this run.
            const authContent = isPlainObject(suppliedAuth) ? suppliedAuth : sourceAuth;
            const effectiveAuth = Object.fromEntries(
              Object.entries(authContent).filter(([, value]) => isValidStoredAuth(value)),
            );
            effectiveAuth[selectedModel.provider] = authEntry;
            timeoutAuthContent = JSON.stringify(effectiveAuth);
            timeoutPluginInstalled = true;
            notes.push(`Enabled a bounded, run-scoped OpenCode model-step timeout for model ${selectedModel.provider}/${selectedModel.model}.`);
          } catch (error) {
            if (pluginPath) await fs.rm(pluginPath, { force: true }).catch(() => undefined);
            notes.push(
              `OpenCode model-step timeout recovery was not enabled for provider ${selectedModel.provider}: ${error instanceof Error && error.message.includes("symlink") ? "the plugins directory is a symlink" : error instanceof Error && error.message.toLowerCase().includes("plugin") ? "existing plugins prevent safe fetch-hook composition" : "private runtime setup failed"}.`,
            );
          }
        }
      }
    }

    // Pin OpenCode's auxiliary "small" model (used for session-title generation and
    // other helper tasks) via PAPERCLIP_OPENCODE_SMALL_MODEL. OpenCode otherwise
    // defaults the small model to a built-in provider default (e.g. a claude-* model
    // for the anthropic provider); when that provider is repointed at a gateway that
    // does not serve that exact model, the title-gen call fails and aborts the run.
    // Setting small_model to a gateway-served model keeps every call on supported models.
    const smallModel = skipPermissions
      ? (input.env.PAPERCLIP_OPENCODE_SMALL_MODEL ?? process.env.PAPERCLIP_OPENCODE_SMALL_MODEL)?.trim()
      : undefined;
    if (smallModel) {
      nextConfig.small_model = smallModel;
      notes.push(`Pinned OpenCode small_model to ${smallModel}.`);
    }
    if (runtimeMcpServers.length > 0) {
      const existingMcp = existingConfig.mcp;
      if (existingMcp !== undefined && !isPlainObject(existingMcp)) {
        throw new Error("OpenCode MCP configuration must be an object to add assigned servers.");
      }
      nextConfig.mcp = buildRuntimeMcpConfig(isPlainObject(existingMcp) ? existingMcp : {}, runtimeMcpServers);
      notes.push(`Injected ${runtimeMcpServers.length} Paperclip-managed MCP server(s) into the private OpenCode runtime config.`);
    }
    // Write a new regular file and rename it over any copied symlink/config.
    // writeFile(..., mode) does not tighten permissions on an existing file.
    const temporaryConfigPath = path.join(runtimeConfigDir, `.opencode-${process.pid}-${Date.now()}.tmp`);
    await fs.writeFile(temporaryConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.chmod(temporaryConfigPath, 0o600);
    await fs.rename(temporaryConfigPath, runtimeConfigPath);

    const taskToolsPath = path.join(runtimeConfigHome, "paperclip-task-tools.mjs");
    await fs.writeFile(taskToolsPath, PAPERCLIP_TASK_TOOLS_SOURCE, { encoding: "utf8", mode: 0o600, flag: "wx" });

    const attributedEnv = preserveExplicitModelModalities({
      ...input.env,
      ...(inlineContent && inlineConfig ? {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          ...inlineConfig,
          provider: attributeOpenCodeProviders(mergeConfigObjects(nextProvider, inlineProvider)),
        }),
      } : {}),
    }, nextProvider, input.config.model);
    const preparedEnv = {
        ...attributedEnv,
        XDG_CONFIG_HOME: runtimeConfigHome,
        ...(timeoutPluginInstalled && timeoutAuthContent ? { OPENCODE_AUTH_CONTENT: timeoutAuthContent } : {}),
      };
    return {
      env: preparedEnv,
      notes,
      runtimeConfigHome,
      taskToolsPath,
      cleanup: async () => {
        await fs.rm(runtimeConfigHome, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(runtimeConfigHome, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Carry declared model modalities into inline config when it leaves them implicit. */
function preserveExplicitModelModalities(
  env: Record<string, string>, providers: unknown, model: unknown,
): Record<string, string> {
  const ref = configuredModelRef(model);
  if (!ref || !isPlainObject(providers)) return env;
  const provider = providers[ref.provider];
  if (!isPlainObject(provider) || !isPlainObject(provider.models)) return env;
  const definition = provider.models[ref.model];
  if (!isPlainObject(definition) || definition.modalities === undefined) return env;
  try {
    const inline = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
    const entry = inline?.provider?.[ref.provider]?.models?.[ref.model];
    if (!isPlainObject(entry) || entry.modalities !== undefined) return env;
    entry.modalities = definition.modalities;
    return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(inline) };
  } catch {
    return env;
  }
}

function attributeOpenCodeProviders(providers: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { openrouter: {}, ...providers };
  for (const [name, value] of Object.entries(result)) {
    if (!isPlainObject(value)) continue;
    const options = isPlainObject(value.options) ? value.options : {};
    if (!isOpenRouterUrl(options.baseURL) && !(name === "openrouter" && options.baseURL === undefined)) continue;
    const headers = isPlainObject(options.headers) ? options.headers as Record<string, string> : {};
    const models = isPlainObject(value.models) ? Object.fromEntries(Object.entries(value.models).map(([id, model]) => [id,
      isPlainObject(model) ? { ...model, headers: openRouterAttributionHeaders(isPlainObject(model.headers) ? model.headers as Record<string, string> : {}) } : model,
    ])) : undefined;
    result[name] = { ...value, options: { ...options, headers: openRouterAttributionHeaders(headers) }, ...(models ? { models } : {}) };
  }
  return result;
}

function mergeConfigObjects(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(override).map(([key, value]) => {
    const previous = base[key];
    return [key, isPlainObject(previous) && isPlainObject(value)
      ? mergeConfigObjects(previous, value) : value];
  });
  return { ...base, ...Object.fromEntries(entries) };
}

/** Managed credentials must never leave host-only homes in a remote process. */
export function prepareManagedOpenCodeRemoteHomes(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  runtimeRootDir: string | null | undefined;
  runId: string;
  configDir?: string;
}): void {
  if (!input.config.managedAiConnection) return;
  if (!input.runtimeRootDir) throw new Error("Managed OpenCode authentication requires an isolated remote runtime directory.");
  const home = path.posix.join(input.runtimeRootDir, "managed-auth", input.runId);
  Object.assign(input.env, {
    HOME: home,
    XDG_CONFIG_HOME: input.configDir ?? path.posix.join(home, "config"),
    XDG_DATA_HOME: path.posix.join(home, "data"),
    XDG_CACHE_HOME: path.posix.join(home, "cache"),
    XDG_STATE_HOME: path.posix.join(home, "state"),
  });
}
