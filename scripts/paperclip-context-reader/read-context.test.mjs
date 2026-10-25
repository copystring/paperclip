import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { OUTPUT_LIMIT, pages, run } from "./read-context.mjs";

const issueId = "11111111-1111-4111-8111-111111111111";
const commentId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";

async function fixture(t, body, responseOptions = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "context-reader-test-"));
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.headers.authorization, "Bearer fixture-secret");
    assert.equal(req.headers["x-paperclip-run-id"], runId);
    res.writeHead(responseOptions.status ?? 200, { "Content-Type": responseOptions.contentType ?? "application/json" });
    res.end(responseOptions.raw ?? JSON.stringify({ id: commentId, issueId, key: "policy", body,
      latestRevisionId: "revision-1", latestRevisionNumber: 3, ...responseOptions.source }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(cwd, { recursive: true, force: true }); });
  return { cwd, env: { PAPERCLIP_RUN_ID: runId, PAPERCLIP_API_KEY: "fixture-secret", PAPERCLIP_API_URL: `http://127.0.0.1:${server.address().port}/api` }, requests: () => requests };
}

test("Unicode, escapes and long lines round-trip through bounded pages without further API calls", async t => {
  const body = ('ÄÖÜß😀漢字\\\"\t\n' + "x".repeat(7000)).repeat(8);
  const f = await fixture(t, body);
  let stdout = await run(["fetch", "--document", `${issueId}/policy`], f.env, f.cwd);
  const contents = [];
  while (true) {
    assert.ok(Buffer.byteLength(stdout) <= OUTPUT_LIMIT);
    const page = JSON.parse(stdout);
    contents.push(page.content);
    if (page.nextPage === null) break;
    stdout = await run(["read", "--manifest", page.manifestPath, "--page", String(page.nextPage)], f.env, f.cwd);
  }
  assert.equal(contents.join(""), body);
  assert.equal(f.requests(), 1);
});
test("single-comment endpoint supplies the exact original plan", async t => {
  const f = await fixture(t, "vollständiger Plan");
  const result = JSON.parse(await run(["fetch", "--comment", `${issueId}/${commentId}`], f.env, f.cwd));
  assert.equal(result.source.kind, "comment");
  assert.equal(result.content, "vollständiger Plan");
});
test("cache cannot silently cross run boundaries", async t => {
  const f = await fixture(t, "rules");
  const page = JSON.parse(await run(["fetch", "--document", `${issueId}/policy`], f.env, f.cwd));
  await assert.rejects(run(["read", "--manifest", page.manifestPath, "--page", "0"], { ...f.env, PAPERCLIP_RUN_ID: commentId }, f.cwd), /different run/);
});
test("changed cached bytes are rejected", async t => {
  const f = await fixture(t, "rules");
  const page = JSON.parse(await run(["fetch", "--document", `${issueId}/policy`], f.env, f.cwd));
  await fs.writeFile(path.join(path.dirname(page.manifestPath), "body.txt"), "changed");
  await assert.rejects(run(["read", "--manifest", page.manifestPath, "--page", "0"], f.env, f.cwd), /identity changed/);
});
test("wrong issue binding and partial document metadata fail closed", async t => {
  const f = await fixture(t, "rules", { source: { issueId: commentId } });
  await assert.rejects(run(["fetch", "--document", `${issueId}/policy`], f.env, f.cwd), /does not match/);
  const partial = await fixture(t, "rules", { source: { latestRevisionId: null } });
  await assert.rejects(run(["fetch", "--document", `${issueId}/policy`], partial.env, partial.cwd), /does not match/);
});
test("error and malformed responses never include the source body or credentials", async t => {
  for (const options of [{ status: 403, raw: "fixture-secret" }, { raw: "fixture-secret malformed JSON" }, { contentType: "text/html", raw: "fixture-secret" }]) {
    const f = await fixture(t, "", options);
    await assert.rejects(run(["fetch", "--document", `${issueId}/policy`], f.env, f.cwd), error => !error.message.includes("fixture-secret"));
  }
});
test("redirects, oversize responses and invalid references are rejected", async t => {
  const redirect = await fixture(t, "", { status: 302 });
  await assert.rejects(run(["fetch", "--document", `${issueId}/policy`], redirect.env, redirect.cwd), /HTTP 302/);
  const large = await fixture(t, "x".repeat(2 * 1024 * 1024));
  await assert.rejects(run(["fetch", "--document", `${issueId}/policy`], large.env, large.cwd), /body limit/);
  await assert.rejects(run(["fetch", "--document", "../policy"], large.env, large.cwd), /Invalid issue/);
});
test("empty source and surrogate boundaries preserve exact content", () => {
  assert.deepEqual(pages(""), [""]);
  for (const body of ["😀".repeat(5000), "\ud800".repeat(5000), '"\\'.repeat(5000)]) {
    assert.equal(pages(body).join(""), body);
    assert.ok(pages(body).every(page => Buffer.byteLength(JSON.stringify(page)) <= 4098));
  }
});
test("malformed Unicode source is rejected before hashing or cache creation", async t => {
  for (const body of ["prefix\ud800suffix", "prefix\udfff".repeat(2000)]) {
    const f = await fixture(t, body);
    await assert.rejects(run(["fetch", "--document", `${issueId}/policy`], f.env, f.cwd), /Unicode/);
    assert.deepEqual(await fs.readdir(f.cwd), []);
  }
});
