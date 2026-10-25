#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OUTPUT_LIMIT = 8192;
const BODY_LIMIT = 2 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = value => createHash("sha256").update(value).digest("hex");

export function pages(body) {
  const result = [];
  let current = "", size = 0;
  for (const character of body) {
    const bytes = Buffer.byteLength(JSON.stringify(character).slice(1, -1));
    if (size + bytes > 4096) { result.push(current); current = ""; size = 0; }
    current += character;
    size += bytes;
  }
  result.push(current);
  return result;
}

function argumentsFor(args) {
  const [mode, ...rest] = args;
  const options = {};
  if (!["fetch", "read"].includes(mode) || rest.length % 2) throw Error("Use fetch --document ISSUE/KEY, fetch --comment ISSUE/UUID, or read --manifest PATH --page N.");
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!key.startsWith("--") || key in options) throw Error("Invalid or duplicate option.");
    options[key] = rest[i + 1];
  }
  const keys = Object.keys(options);
  if (mode === "fetch" && (keys.length !== 1 || !["--document", "--comment"].includes(keys[0]))) throw Error("Select exactly one document or comment.");
  if (mode === "read" && (keys.length !== 2 || !options["--manifest"] || !/^\d+$/.test(options["--page"] ?? ""))) throw Error("Read requires a manifest and a nonnegative page number.");
  return { mode, options };
}

function output(manifest, manifestPath, body, page) {
  const all = pages(body);
  if (!Number.isSafeInteger(page) || page < 0 || page >= all.length) throw Error("Page outside the source body.");
  const value = { source: manifest.source, revision: manifest.revision, bodySha256: manifest.bodySha256,
    bodyBytes: manifest.bodyBytes, page, totalPages: all.length, lastPage: page === all.length - 1,
    nextPage: page + 1 < all.length ? page + 1 : null, manifestPath, content: all[page] };
  const stdout = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(stdout) > OUTPUT_LIMIT) throw Error("Output metadata exceeds the bounded response limit.");
  return stdout;
}

async function checkedFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BODY_LIMIT + 8192) throw Error("Invalid private context file.");
  if (process.geteuid && (stat.uid !== process.geteuid() || (stat.mode & 0o077))) throw Error("Context file is not private and owned by this service user.");
  return fs.readFile(file, "utf8");
}

export async function run(args, env = process.env, cwd = process.cwd()) {
  const { mode, options } = argumentsFor(args);
  if (!env.PAPERCLIP_RUN_ID || !UUID.test(env.PAPERCLIP_RUN_ID)) throw Error("A current Paperclip run ID is required.");
  if (mode === "read") {
    const manifestPath = path.resolve(cwd, options["--manifest"]);
    const directory = path.dirname(manifestPath);
    const directoryStat = await fs.lstat(directory);
    if (path.basename(manifestPath) !== "manifest.json" || !path.basename(directory).startsWith(".paperclip-context-") || !directoryStat.isDirectory() || directoryStat.isSymbolicLink() || await fs.realpath(path.dirname(directory)) !== await fs.realpath(cwd)) throw Error("Manifest is outside this workspace context cache.");
    const manifest = JSON.parse(await checkedFile(manifestPath));
    if (manifest.runId !== env.PAPERCLIP_RUN_ID) throw Error("Context belongs to a different run; fetch current sources.");
    const body = await checkedFile(path.join(directory, "body.txt"));
    if (digest(body) !== manifest.bodySha256 || Buffer.byteLength(body) !== manifest.bodyBytes) throw Error("Cached source identity changed.");
    return output(manifest, manifestPath, body, Number(options["--page"]));
  }
  const kind = options["--document"] ? "document" : "comment";
  const reference = options["--document"] ?? options["--comment"];
  const [issue, key, extra] = reference.split("/");
  if (extra !== undefined || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(issue ?? "") || !(kind === "comment" ? UUID.test(key ?? "") : /^[a-z0-9][a-z0-9_-]{0,63}$/.test(key ?? ""))) throw Error("Invalid issue/source reference.");
  if (!env.PAPERCLIP_API_KEY || !env.PAPERCLIP_API_URL) throw Error("Existing run API credentials are required.");
  const base = new URL(env.PAPERCLIP_API_URL);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw Error("Invalid configured API base.");
  const basePath = base.pathname.replace(/\/+$/, "").replace(/\/api$/i, "");
  const endpoint = new URL(`${base.origin}${basePath}/api/issues/${encodeURIComponent(issue)}/${kind === "document" ? "documents" : "comments"}/${encodeURIComponent(key)}`);
  const response = await fetch(endpoint, { redirect: "manual", signal: AbortSignal.timeout(30000), headers: {
    Authorization: `Bearer ${env.PAPERCLIP_API_KEY}`, "X-Paperclip-Run-Id": env.PAPERCLIP_RUN_ID, Accept: "application/json" } });
  if (!response.ok) throw Error(`Source GET failed with HTTP ${response.status}.`);
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) throw Error("Source response is not JSON.");
  const reader = response.body?.getReader();
  if (!reader) throw Error("Source response has no body.");
  const chunks = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > BODY_LIMIT) { await reader.cancel(); throw Error("Source response exceeds the body limit."); }
    chunks.push(Buffer.from(value));
  }
  let source;
  try { source = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw Error("Source response is not valid UTF-8 JSON."); }
  if (!source || typeof source.body !== "string" || !UUID.test(source.issueId ?? "") || (UUID.test(issue) && source.issueId.toLowerCase() !== issue.toLowerCase()) || (kind === "comment" ? source.id !== key : source.key !== key || typeof source.latestRevisionId !== "string" || !source.latestRevisionId || !Number.isSafeInteger(source.latestRevisionNumber) || source.latestRevisionNumber < 1)) throw Error("Response does not match the complete requested source.");
  if (!source.body.isWellFormed()) throw Error("Source body contains malformed Unicode.");
  const manifest = { runId: env.PAPERCLIP_RUN_ID, source: { kind, requestedIssue: issue, issueId: source.issueId, key },
    revision: kind === "document" ? { id: source.latestRevisionId, number: source.latestRevisionNumber } : { id: source.id, updatedAt: source.updatedAt ?? source.createdAt ?? null },
    bodySha256: digest(source.body), bodyBytes: Buffer.byteLength(source.body) };
  const directory = await fs.mkdtemp(path.join(await fs.realpath(cwd), ".paperclip-context-"));
  await fs.chmod(directory, 0o700);
  const manifestPath = path.join(directory, "manifest.json");
  try {
    await fs.writeFile(path.join(directory, "body.txt"), source.body, { flag: "wx", mode: 0o600 });
    await fs.writeFile(manifestPath, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    return output(manifest, manifestPath, source.body, 0);
  } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(await run(process.argv.slice(2))); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : "Context read failed.") + "\n"); process.exitCode = 1; }
}
