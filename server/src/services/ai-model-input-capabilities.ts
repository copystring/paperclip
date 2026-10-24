import { createHash } from "node:crypto";
import { aiRoutingBaseUrl, type AiProviderRouting } from "@paperclipai/shared";

const cache = new Map<string, { expires: number; vision: boolean | undefined }>();

/** Discover only advertised image support; unknown never means unsupported. */
export async function managedModelVision(
  route: AiProviderRouting,
  credential: string,
  model: string,
  request: typeof fetch = fetch,
): Promise<boolean | undefined> {
  if (!["gateway", "local"].includes(route.kind) || route.protocol !== "chat") return undefined;
  const id = model.startsWith("paperclip/") ? model.slice("paperclip/".length) : model;
  if (!id) return undefined;
  const endpoint = `${aiRoutingBaseUrl(route, "opencode_local").replace(/\/$/, "")}/models`;
  // Credential changes must not reuse another account's advertised catalog.
  const key = createHash("sha256").update(JSON.stringify([endpoint, route.auth, credential, id])).digest("hex");
  const prior = cache.get(key);
  if (prior && prior.expires > Date.now()) return prior.vision;
  let vision: boolean | undefined;
  try {
    const response = await request(endpoint, {
      headers: route.auth === "none" ? {} : { Authorization: `Bearer ${credential}` },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); return undefined; }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 2 * 1024 * 1024) throw new Error("Model catalog too large");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const catalog = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const entry = Array.isArray(catalog?.data)
      ? catalog.data.find((entry: unknown) => entry !== null && typeof entry === "object" && (entry as { id?: unknown }).id === id)
      : undefined;
    if (typeof entry?.capabilities?.vision === "boolean") vision = entry.capabilities.vision;
    else if (Array.isArray(entry?.input_modalities) && entry.input_modalities.every((value: unknown) => typeof value === "string"))
      vision = entry.input_modalities.includes("image");
  } catch {
    // Catalog discovery is optional. Preserve the harness's normal model
    // metadata when unavailable; never fail an unrelated text task or log keys.
  }
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + (vision === undefined ? 10_000 : 300_000), vision });
  return vision;
}
