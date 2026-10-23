import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { requestMcpHttpToolsList, McpHttpInitializationError } from "../services/mcp-http.js";

it("discovers the real Smoke Lab HTTP fixture through the complete MCP handshake", async () => {
  const fixture = fileURLToPath(new URL("../../../scripts/mcp-fixtures/servers/http-fixture.mjs", import.meta.url));
  const child = spawn(process.execPath, [fixture], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  try {
    const ready = await new Promise<{ port: number }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Smoke Lab fixture did not start")), 5_000);
      const fail = (error: Error) => { clearTimeout(timeout); reject(error); };
      child.once("error", fail);
      lines.once("line", line => {
        clearTimeout(timeout);
        child.off("error", fail);
        try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
      });
    });
    const methods: string[] = [];
    const { response } = await requestMcpHttpToolsList({
      scope: `smoke-lab-fixture-${randomUUID()}`,
      requestId: "smoke-catalog",
      send: async init => {
        methods.push(JSON.parse(String(init.body)).method);
        return fetch(`http://127.0.0.1:${ready.port}/mcp`, init);
      },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).result.tools.map((tool: { name: string }) => tool.name)).toContain("todo.list");
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});

type Options = {
  stateless?: boolean;
  initializeStatus?: number;
  notificationStatus?: number;
  listStatuses?: number[];
  malformed?: boolean;
};

async function withServer(options: Options, run: (fixture: {
  requests: Array<{ method: string; session: string | undefined; auth: string | undefined }>;
  discover: (auth?: string) => ReturnType<typeof requestMcpHttpToolsList>;
}) => Promise<void>) {
  const requests: Array<{ method: string; session: string | undefined; auth: string | undefined }> = [];
  let sequence = 0;
  let lists = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const session = request.headers["mcp-session-id"] as string | undefined;
    requests.push({ method: payload.method, session, auth: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    if (payload.method === "initialize") {
      sequence += 1;
      response.statusCode = options.initializeStatus ?? 200;
      if (response.statusCode === 401) response.setHeader("www-authenticate", 'Bearer realm="fixture"');
      if (!options.stateless) response.setHeader("mcp-session-id", `session-${sequence}`);
      response.end(options.malformed ? "invalid" : JSON.stringify({ jsonrpc: "2.0", id: payload.id,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } }));
    } else if (payload.method === "notifications/initialized") {
      response.statusCode = options.notificationStatus ?? 202;
      if (response.statusCode === 401) response.setHeader("www-authenticate", 'Bearer realm="fixture"');
      response.end();
    } else {
      response.statusCode = options.listStatuses?.[lists++] ?? 200;
      response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { tools: [{ name: "read" }] } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  const scope = randomUUID();
  try {
    await run({ requests, discover: (auth = "Bearer first") => requestMcpHttpToolsList({
      scope, headers: { Authorization: auth }, requestId: "catalog",
      send: (init) => fetch(endpoint, init),
    }) });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("MCP HTTP catalog lifecycle", () => {
  it.each([false, true])("initializes before listing, including stateless=%s, and reuses the session", async (stateless) => {
    await withServer({ stateless }, async ({ requests, discover }) => {
      const first = await discover();
      expect(await first.response.json()).toMatchObject({ result: { tools: [{ name: "read" }] } });
      await (await discover()).response.body?.cancel();
      expect(requests.map((request) => request.method)).toEqual([
        "initialize", "notifications/initialized", "tools/list", "tools/list",
      ]);
      expect(requests.map((request) => request.session)).toEqual([
        undefined, ...Array(3).fill(stateless ? undefined : "session-1"),
      ]);
      expect(requests.every((request) => request.auth === "Bearer first")).toBe(true);
    });
  });

  it("isolates sessions when credentials change", async () => {
    await withServer({}, async ({ requests, discover }) => {
      await (await discover()).response.body?.cancel();
      await (await discover("Bearer refreshed")).response.body?.cancel();
      expect(requests.map((request) => request.method)).toEqual([
        "initialize", "notifications/initialized", "tools/list",
        "initialize", "notifications/initialized", "tools/list",
      ]);
      expect(requests[3]).toEqual({ method: "initialize", session: undefined, auth: "Bearer refreshed" });
      expect(requests[5].session).toBe("session-2");
    });
  });

  it.each([200, 404])("renegotiates an expired session once, then returns HTTP %s", async (status) => {
    await withServer({ listStatuses: [404, status] }, async ({ requests, discover }) => {
      const result = await discover();
      expect(result.response.status).toBe(status);
      await result.response.body?.cancel();
      expect(requests.map((request) => request.method)).toEqual([
        "initialize", "notifications/initialized", "tools/list",
        "initialize", "notifications/initialized", "tools/list",
      ]);
      expect(requests[5].session).toBe("session-2");
      if (status === 404) {
        await (await discover()).response.body?.cancel();
        expect(requests[6].method).toBe("initialize");
      }
    });
  });

  it("does not retry a stateless endpoint's 404", async () => {
    await withServer({ stateless: true, listStatuses: [404] }, async ({ requests, discover }) => {
      const result = await discover();
      expect(result.response.status).toBe(404);
      await result.response.body?.cancel();
      expect(requests).toHaveLength(3);
    });
  });

  it.each([401, 404])("preserves initialize HTTP %s without listing tools", async (status) => {
    await withServer({ initializeStatus: status }, async ({ requests, discover }) => {
      try {
        await discover();
        expect.fail("Expected initialization to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(McpHttpInitializationError);
        const failure = error as McpHttpInitializationError;
        expect(failure.response?.status).toBe(status);
        if (status === 401) expect(failure.response?.headers.get("www-authenticate")).toBe('Bearer realm="fixture"');
        await failure.response?.body?.cancel();
      }
      expect(requests.map((request) => request.method)).toEqual(["initialize"]);
    });
  });

  it("does not list or cache a session after the initialized notification fails", async () => {
    await withServer({ notificationStatus: 503 }, async ({ requests, discover }) => {
      await expect(discover()).rejects.toBeInstanceOf(McpHttpInitializationError);
      await expect(discover()).rejects.toBeInstanceOf(McpHttpInitializationError);
      expect(requests.map((request) => request.method)).toEqual([
        "initialize", "notifications/initialized", "initialize", "notifications/initialized",
      ]);
    });
  });

  it("retains a notification auth challenge for the credential refresh path", async () => {
    await withServer({ notificationStatus: 401 }, async ({ requests, discover }) => {
      try {
        await discover();
        expect.fail("Expected authentication to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(McpHttpInitializationError);
        const failure = error as McpHttpInitializationError;
        expect(failure.stage).toBe("initialized_notification");
        expect(failure.response?.status).toBe(401);
        expect(failure.response?.headers.get("www-authenticate")).toBe('Bearer realm="fixture"');
        await failure.response?.body?.cancel();
      }
      expect(requests.map((request) => request.method)).toEqual(["initialize", "notifications/initialized"]);
    });
  });

  it("does not list tools after a malformed initialize result", async () => {
    await withServer({ malformed: true }, async ({ requests, discover }) => {
      await expect(discover()).rejects.toBeInstanceOf(McpHttpInitializationError);
      expect(requests.map((request) => request.method)).toEqual(["initialize"]);
    });
  });
});
