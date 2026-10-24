import express from "express";
import request from "supertest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { markIdleIngressTracked, markIdleStartupComplete } from "../services/idle-local-work.js";
import { startTaskDrain, stopTaskDrain } from "../services/task-admission.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const mockGetDrainStatus = vi.hoisted(() => vi.fn());
vi.mock("../services/index.js", () => ({
  companyService: () => ({ listCompanyIds: async () => [] }),
  heartbeatService: () => ({ getTaskDrainStatus: mockGetDrainStatus }),
  instanceSettingsService: () => ({}),
  logActivity: vi.fn(),
  publishActivity: vi.fn(),
}));
vi.mock("../services/environments.js", () => ({ environmentService: () => ({}) }));

import { instanceSettingsRoutes } from "../routes/instance-settings.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping restart readiness route integration: ${support.reason}`);
(support.supported ? describe : describe.skip)("restart readiness HTTP integration", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let home: string;
  let liveDrain: ReturnType<typeof startTaskDrain>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("restart-readiness-http-");
    db = createDb(database.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "restart-readiness-http-home-"));
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); if (home) await fs.rm(home, { recursive: true, force: true }); });
  beforeEach(() => {
    mockGetDrainStatus.mockClear();
    vi.stubEnv("PAPERCLIP_HOME", home);
    markIdleIngressTracked();
    markIdleStartupComplete({ scheduledBackups: true });
    liveDrain = startTaskDrain({ purpose: "idle", ttlMs: 60_000 });
    mockGetDrainStatus.mockReturnValue({ ...liveDrain, draining: true, activeRuns: 0, pendingWakes: 0, quiescent: true });
  });
  afterEach(() => { stopTaskDrain(); vi.unstubAllEnvs(); });

  it("returns the real database service result in the documented HTTP envelope", async () => {
    const workers = {
      inspectIdleSleep: vi.fn(async () => ({ backgroundWork: "none" as const, pluginIds: [] })),
    } as unknown as PluginWorkerManager;
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", isInstanceAdmin: true } as never;
      next();
    });
    app.use("/api", instanceSettingsRoutes(db as unknown as Db, workers));

    const response = await request(app)
      .get(`/api/instance/task-drain?restartReadiness=1&ownerId=${liveDrain.ownerId}`)
      .expect(200);

    expect(response.body.restartReadiness).toEqual({
      version: 1,
      status: "ready",
      ownerId: liveDrain.ownerId,
      startedAt: liveDrain.startedAt.toISOString(),
      expiresAt: liveDrain.expiresAt.toISOString(),
      serverPid: process.pid,
      generation: expect.any(Number),
      blockers: [],
    });
    expect(response.body).toMatchObject({
      draining: true,
      ownerId: liveDrain.ownerId,
      startedAt: liveDrain.startedAt.toISOString(),
      expiresAt: liveDrain.expiresAt.toISOString(),
      restartReadiness: { status: "ready", version: 1 },
    });
    expect(workers.inspectIdleSleep).toHaveBeenCalledWith({ ownerId: liveDrain.ownerId, expiresAt: liveDrain.expiresAt.getTime() });
  });
});
