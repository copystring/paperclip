import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "../../vendor/paperclip-runner/index.js";
import { createAssignedMcpTools } from "./assigned-mcp-tools.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { RUNNER_TOOL_RESULT_MAX_BYTES } from "./runner-tool-results.js";
import type { ToolGatewayService } from "../tool-gateway.js";

describe("saved assigned results through actual PRP", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const oldSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer();
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (oldSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = oldSecret;
  });

  it.skipIf(!process.env.PAPERCLIP_REQUIRE_RUNNER_API_INTEGRATION && !existsSync(defaultCapabilityRunnerdBinary()))("delivers escape-heavy 500 KB pages through actual PRP without truncation", async () => {
    const fixture = await server.fixture({ apiToolsEnabled: false });
    const original = { content: '🧭é"\\\n\u0000'.repeat(60_000), last: "complete-result" };
    const expected = JSON.stringify(original);
    const digest = createHash("sha256").update(expected).digest("hex");
    const inline = { content: "\\".repeat(200_000) };
    const inlineDigest = createHash("sha256").update(JSON.stringify(inline)).digest("hex");
    const providerWireSize = (value: unknown) => Buffer.byteLength(JSON.stringify({ success: true,
      contentItems: [{ type: "inputText", text: JSON.stringify(value) }] }));
    expect(Buffer.byteLength(JSON.stringify(inline))).toBeLessThan(RUNNER_TOOL_RESULT_MAX_BYTES);
    expect(providerWireSize(inline)).toBeGreaterThan(RUNNER_TOOL_RESULT_MAX_BYTES);
    const executeTool = vi.fn(async (call: { parameters: Record<string, unknown> }) => ({
      status: "completed" as const, result: call.parameters.variant === "inline" ? inline : original,
    }));
    const assignedMcpTools = await createAssignedMcpTools({
      gatewayPublicId: "fixture", bearerToken: "fixture",
      gateway: {
        listToolsForNamedGateway: async () => [{ name: "app:read", displayName: "Read", description: "Fixture read",
          parametersSchema: { type: "object", properties: { variant: { type: "string", enum: ["large", "inline"] } } },
          pluginId: "fixture", providerType: "mcp_remote_http", risk: "read" }],
        executeTool,
      } as unknown as ToolGatewayService,
    });
    const authority = new PaperclipRunnerToolAuthority(server.db, { ...fixture.authority.binding, assignedMcpTools });
    const provider = join(server.root, "scripted-saved-result-provider.mjs");
    await writeFile(provider, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let step=0, artifactId, restored='', phase=0;
const call = (tool,args) => { step++; send({id:'call-'+step,method:'item/tool/call',params:{threadId:'saved-thread',turnId:'saved-turn',itemId:'item-'+step,callId:'saved-call-'+step,tool,arguments:args}}); };
for await (const line of createInterface({input:process.stdin})) {
  const m=JSON.parse(line);
  if (!m.method) {
    if (String(m.id).startsWith('call-')) {
      const envelope=JSON.parse(m.result.contentItems[0].text);
      const result=envelope.result ?? envelope;
      if (result.artifact) {
        if(!result.readWith || result.readWith.tool!=='read_tool_result' || result.readWith.arguments.offsetBytes!==0) throw new Error('Captured result omitted its first-page instruction');
        artifactId=result.artifact.artifactId;
        restored='';
        call(result.readWith.tool,{...result.readWith.arguments});
      } else {
        if(!result.ok || result.responseText.offsetBytes!==Buffer.byteLength(restored)) throw new Error('Invalid page receipt');
        restored+=result.data;
        if(result.responseText.nextOffsetBytes!==null) call('read_tool_result',{artifactId,offsetBytes:result.responseText.nextOffsetBytes});
        else {
          const expectedDigest=phase===0?'${digest}':'${inlineDigest}';
          if(createHash('sha256').update(restored).digest('hex')!==expectedDigest) throw new Error('Provider received incomplete saved JSON');
          if(phase===0) { phase=1; call('${assignedMcpTools.definitions()[0]!.name}',{variant:'inline'}); }
          else {
            send({method:'item/completed',params:{threadId:'saved-thread',turnId:'saved-turn',item:{id:'saved-answer',type:'agentMessage',text:'all-pages-verified'}}});
            send({method:'turn/completed',params:{turn:{id:'saved-turn',status:'completed'}}});
          }
        }
      }
    }
    continue;
  }
  if(m.method==='initialize') send({id:m.id,result:{userAgent:'scripted-saved-result-provider'}});
  else if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'saved-thread',sessionId:'saved-session'}}});
  else if(m.method==='turn/start') {send({id:m.id,result:{turn:{id:'saved-turn',status:'inProgress'}}});send({method:'turn/started',params:{turn:{id:'saved-turn'}}});call('${assignedMcpTools.definitions()[0]!.name}',{variant:'large'});}
  else if(m.id!==undefined) send({id:m.id,result:{}});
}
`);
    await chmod(provider, 0o700);
    const bundle = createRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: provider, codexArgs: [],
      stateDirectory: join(server.root, "scripted-saved-result-runner"), lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      prpIdentity: { runnerInstanceId: "saved-test", environmentLeaseId: "saved-test-lease", runId: fixture.runId,
        normalizedSessionId: "saved-test-session", turnId: "saved-test-turn", itemId: "saved-test-item" },
    });
    const sizes: Array<{ result: number; wrapper: number }> = [];
    const failureEvidence = () => {
      const evidence = bundle.evidence();
      return {
        sizes: sizes.slice(-8),
        notifications: notifications.slice(-12),
        runnerExited: evidence.runnerExited,
        runnerExitCode: evidence.runnerExitCode,
        runnerSignal: evidence.runnerSignal,
        // Diagnostics are useful to explain a native transport timeout, but
        // cap both count and text length so failures cannot dump unbounded logs.
        diagnostics: evidence.diagnostics.slice(-8).map((message) => message.slice(0, 300)),
      };
    };
    bundle.transport.setServerRequestHandler(async request => {
      const params = request.params;
      const result = await authority.execute({ tool: String(params.tool), arguments: params.arguments, callId: String(params.callId) });
      const response = { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
      sizes.push({ result: Buffer.byteLength(JSON.stringify(result)), wrapper: Buffer.byteLength(JSON.stringify(response)) });
      return response;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let verified = false;
    const notifications: Array<{ method: string; type: unknown; status?: string }> = [];
    try {
      await bundle.transport.request("initialize", {});
      await bundle.transport.request("thread/start", { cwd: fixture.workspace, dynamicTools: authority.definitions() });
      await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Read every saved result page" }] });
      await Promise.race([
        (async () => { for await (const notification of bundle.transport.notifications()) {
          notifications.push({ method: notification.method, type: (notification.params.item as { type?: string })?.type,
            status: (notification.params.turn as { status?: string })?.status });
          if (notification.method === "item/completed" && (notification.params.item as { text?: string })?.text === "all-pages-verified") verified = true;
          if (notification.method === "turn/completed") {
            const status = (notification.params.turn as { status?: string })?.status;
            if (status !== "completed") throw new Error(`PRP turn ended with status ${status ?? "unknown"}: ${JSON.stringify(failureEvidence())}`);
            return;
          }
          if (notification.method === "turn/failed" || notification.method === "item/failed") {
            throw new Error(`PRP emitted terminal ${notification.method}: ${JSON.stringify(failureEvidence())}`);
          }
        } })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Escaped pages did not reach the provider: ${JSON.stringify(failureEvidence())}`)), 15_000); }),
      ]);
      expect(verified, JSON.stringify(failureEvidence())).toBe(true);
      expect(executeTool.mock.calls.map(([call]) => call.parameters)).toEqual([{ variant: "large" }, { variant: "inline" }]);
      expect(sizes.every(size => size.wrapper <= RUNNER_TOOL_RESULT_MAX_BYTES)).toBe(true);
      expect(bundle.evidence().diagnostics).toContain("runnerd authenticated to the durable PRP control plane");
    } finally { clearTimeout(timer); await bundle.transport.close(); }
  }, 30_000);
});
