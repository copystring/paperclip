import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { isOpenRouterUrl, openRouterAttributionHeaders } from "@paperclipai/adapter-utils/openrouter-attribution";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";

const MAX_RUNTIME_MCP_SERVER_NAME_LENGTH = 22;

type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  runtimeConfigHome: string | null;
  cleanup: () => Promise<void>;
};

function resolveXdgConfigHome(env: Record<string, string>): string {
  return (
    (typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()) ||
    (typeof process.env.XDG_CONFIG_HOME === "string" && process.env.XDG_CONFIG_HOME.trim()) ||
    path.join(os.homedir(), ".config")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function parseConfiguredModelRef(raw: unknown): { provider: string; model: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
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

async function replaceRuntimeConfigSymlink(filepath: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filepath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return;
    throw err;
  }
  if (!stat.isSymbolicLink()) return;

  let contents: Buffer | null = null;
  try {
    contents = await fs.readFile(filepath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw err;
  }
  await fs.unlink(filepath);
  if (contents) await fs.writeFile(filepath, contents, { mode: 0o600 });
}

/** Carry effective explicit settings into the inline layer before catalog discovery. */
function preserveExplicitModelModalities(
  env: Record<string, string>, providers: unknown, model: unknown,
): Record<string, string> {
  const ref = parseConfiguredModelRef(model);
  if (!ref || !isPlainObject(providers)) return env;
  const provider = providers[ref.provider];
  if (!isPlainObject(provider) || !isPlainObject(provider.models)) return env;
  const definition = provider.models[ref.model];
  if (!isPlainObject(definition) || definition.modalities === undefined) return env;
  try {
    const inline = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
    const entry = inline?.provider?.[ref.provider]?.models?.[ref.model];
    // Inline settings have higher priority. Only fill the omitted field on an
    // existing entry, so discovery cannot shadow explicit disk/provider input.
    if (!isPlainObject(entry) || entry.modalities !== undefined) return env;
    entry.modalities = definition.modalities;
    return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(inline) };
  } catch {
    return env;
  }
}

export async function prepareOpenCodeRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  targetIsRemote?: boolean;
  runtimeMcpServers?: readonly AdapterRuntimeMcpServer[];
}): Promise<PreparedOpenCodeRuntimeConfig> {
  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, true);
  const runtimeMcpServers = input.runtimeMcpServers ?? [];
  const targetIsRemote = input.targetIsRemote === true;
  const notes = [
    skipPermissions
      ? "Injected runtime OpenCode config with permission=allow for all tools and connections."
      : "Prepared isolated OpenCode provider configuration.",
  ];
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const gatewayProviders = parseProviderConfig(
    input.env.PAPERCLIP_OPENCODE_PROVIDERS ?? process.env.PAPERCLIP_OPENCODE_PROVIDERS,
    resolveEnv,
    notes,
  );
  const smallModel = (input.env.PAPERCLIP_OPENCODE_SMALL_MODEL ?? process.env.PAPERCLIP_OPENCODE_SMALL_MODEL)?.trim();
  if (targetIsRemote && !skipPermissions && !gatewayProviders && !smallModel && runtimeMcpServers.length === 0) {
    return {
      env: preserveExplicitModelModalities(input.env, undefined, input.config.model),
      notes,
      runtimeConfigHome: null,
      cleanup: async () => {},
    };
  }

  const sourceConfigDir = targetIsRemote
    ? null
    : path.join(resolveXdgConfigHome(input.env), "opencode");
  const runtimeConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-config-"));
  const runtimeConfigDir = path.join(runtimeConfigHome, "opencode");
  const runtimeConfigPath = path.join(runtimeConfigDir, "opencode.json");

  let cleanupDone = false;
  const cleanup = async () => {
    if (cleanupDone) return;
    cleanupDone = true;
    await fs.rm(runtimeConfigHome, { recursive: true, force: true });
  };

  try {
  await fs.mkdir(runtimeConfigDir, { recursive: true, mode: 0o700 });
  if (sourceConfigDir) {
    try {
      await fs.cp(sourceConfigDir, runtimeConfigDir, {
        recursive: true,
        force: true,
        errorOnExist: false,
        dereference: false,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
        await cleanup();
        throw err;
      }
    }
  }

  await replaceRuntimeConfigSymlink(runtimeConfigPath);
  const existingConfig = await readJsonObject(runtimeConfigPath);
  const existingProvider = isPlainObject(existingConfig.provider) ? existingConfig.provider : {};
  let nextProvider = gatewayProviders
    ? { ...existingProvider, ...gatewayProviders }
    : existingProvider;
  if (gatewayProviders) {
    notes.push(
      `Injected ${Object.keys(gatewayProviders).length} custom OpenCode provider(s) from PAPERCLIP_OPENCODE_PROVIDERS: ${Object.keys(gatewayProviders).join(", ")}.`,
    );
  }

  // Register the configured model on its provider's models map. OpenCode resolves
  // `--model provider/model` only when the model id exists in that map, so ids the
  // models.dev catalog does not carry — OpenRouter routing variants such as
  // `openai/gpt-oss-120b:nitro`, or models newer than the bundled catalog — are
  // otherwise rejected with "Model not found" even though the provider serves them.
  // An empty entry deep-merges with catalog metadata, so this is a no-op for models
  // the catalog already knows, and we never clobber an explicit definition from the
  // user config or PAPERCLIP_OPENCODE_PROVIDERS.
  const configuredModel = parseConfiguredModelRef(input.config.model);
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
  let inlineConfig: Record<string, unknown> | undefined;
  if (inlineContent) {
    try {
      const parsed: unknown = JSON.parse(inlineContent);
      if (isPlainObject(parsed)) inlineConfig = parsed;
    } catch {
      // OpenCode must still report invalid operator configuration.
    }
  }
  nextProvider = attributeOpenCodeProviders(mergeConfigObjects(
    nextProvider,
    isPlainObject(inlineConfig?.provider) ? inlineConfig.provider : {},
  ));

  const nextConfig: Record<string, unknown> = {
    ...existingConfig,
    ...(skipPermissions ? { permission: "allow" } : {}),
  };
  if (Object.keys(nextProvider).length > 0) {
    nextConfig.provider = nextProvider;
  }

  if (runtimeMcpServers.length > 0) {
    const existingMcp = isPlainObject(existingConfig.mcp) ? existingConfig.mcp : {};
    nextConfig.mcp = buildRuntimeMcpConfig(existingMcp, runtimeMcpServers);
    notes.push(`Injected ${runtimeMcpServers.length} run-scoped Paperclip MCP server(s) into OpenCode.`);
  }

  // Pin OpenCode's auxiliary "small" model (used for session-title generation and
  // other helper tasks) via PAPERCLIP_OPENCODE_SMALL_MODEL. OpenCode otherwise
  // defaults the small model to a built-in provider default (e.g. a claude-* model
  // for the anthropic provider); when that provider is repointed at a gateway that
  // does not serve that exact model, the title-gen call fails and aborts the run.
  // Setting small_model to a gateway-served model keeps every call on supported models.
  if (smallModel) {
    nextConfig.small_model = smallModel;
    notes.push(`Pinned OpenCode small_model to ${smallModel}.`);
  }
  await fs.writeFile(runtimeConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(runtimeConfigPath, 0o600);

  const runtimeEnv = preserveExplicitModelModalities(input.env, nextProvider, input.config.model);
  return {
    env: {
      ...runtimeEnv,
      XDG_CONFIG_HOME: runtimeConfigHome,
      ...(inlineContent
        ? {
            OPENCODE_CONFIG_CONTENT: inlineConfig
              ? JSON.stringify({ ...inlineConfig, provider: nextProvider })
              : inlineContent,
          }
        : {}),
    },
    notes,
    runtimeConfigHome,
    cleanup,
  };
  } catch (error) {
    await cleanup();
    throw error;
  }
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

/** Native provider defaults and per-model headers can both carry harness attribution. */
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
