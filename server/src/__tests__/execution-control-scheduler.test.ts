import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it, vi } from "vitest";

// Exercise the actual startup wiring without booting the HTTP server or a database.
const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const start = source.indexOf("  const executionControlSweepsInFlight =");
const end = source.indexOf("  const executionControlInterval =", start);
if (start < 0 || end < start) throw new Error("Execution control startup wiring not found");
const wiring = stripTypeScriptTypes(source.slice(start, end) + "\nglobalThis.sweep = sweepExecutionControl;");

describe("durable execution control startup wiring", () => {
  for (const periodicEnabled of [true, false]) {
    it(`delivers reconciled work and checks replacements with periodic heartbeats ${periodicEnabled ? "on" : "off"}`, async () => {
      const wakeup = vi.fn();
      const runtime = { wakeup };
      const delivered = vi.fn(async () => {});
      const replacements = vi.fn(async () => {});
      const pending: Promise<unknown>[] = [];
      const context = {
        db: {}, heartbeat: periodicEnabled ? runtime : null, accountingHeartbeat: runtime,
        isIdleTaskDrainActive: () => false, heartbeatSchedulerStopped: false, isWarmStandby: () => false,
        trackHeartbeatSchedulerWork: (work: Promise<unknown>) => pending.push(work),
        reconcileAbandonedExecutionControl: vi.fn(async () => {}),
        reconcileSafeNativeReplacements: replacements,
        verifyStoppedNativeSessionForReplacement: vi.fn(),
        deliverReconciledExecutions: delivered,
        deliverExecutionStatuses: vi.fn(async () => {}),
        settleUnrecoverableExecutions: vi.fn(async () => {}),
        localAiLoginService: () => ({ reapExpired: vi.fn(async () => {}) }),
        logger: { error: vi.fn() }, sweep: () => {},
      };
      runInNewContext(wiring, context);
      context.sweep();
      context.sweep(); // A second tick must not overlap an in-flight queue.
      await Promise.all(pending);
      expect(delivered).toHaveBeenCalledExactlyOnceWith(context.db, wakeup);
      expect(replacements).toHaveBeenCalledTimes(1);
    });
  }
  it.each(["drain", "standby", "shutdown"])("does not dispatch during %s", async mode => {
    const delivered = vi.fn();
    const context = {
      db: {}, heartbeat: null, accountingHeartbeat: { wakeup: vi.fn() },
      isIdleTaskDrainActive: () => mode === "drain", heartbeatSchedulerStopped: mode === "shutdown",
      isWarmStandby: () => mode === "standby", trackHeartbeatSchedulerWork: vi.fn(),
      reconcileAbandonedExecutionControl: vi.fn(), reconcileSafeNativeReplacements: vi.fn(),
      verifyStoppedNativeSessionForReplacement: vi.fn(), deliverReconciledExecutions: delivered,
      deliverExecutionStatuses: vi.fn(), settleUnrecoverableExecutions: vi.fn(),
      localAiLoginService: vi.fn(), logger: { error: vi.fn() }, sweep: () => {},
    };
    runInNewContext(wiring, context);
    context.sweep();
    expect(context.trackHeartbeatSchedulerWork).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
  });
});
