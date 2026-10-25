import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it, vi } from "vitest";

// Exercise the extracted worker registration without booting the HTTP server or a database.
const source = readFileSync(new URL("../services/execution-control-work.ts", import.meta.url), "utf8");
const start = source.indexOf("export function registerExecutionControlWork(");
const end = source.indexOf("\nexport function executionControlSchedule(", start);
if (start < 0 || end < start) throw new Error("Execution control worker registration not found");
const wiring = stripTypeScriptTypes(source.slice(start, end).replace("export function", "function") +
  "\nglobalThis.registerExecutionControlWork = registerExecutionControlWork;");
const EXECUTION_RECONCILIATION_INTERVAL_MS = 60_000;

type Duty = { queue: string; run: () => Promise<unknown>; next: () => Promise<number | null> };
type Worker = {
  pausePassiveMaintenance: boolean;
  run: () => Promise<void>;
  hasPending: () => Promise<boolean>;
  nextRunAt: () => number | null;
};
type Coordinator = {
  register: (queue: string, worker: Worker) => { ready: Promise<void> };
};
type RegisterExecutionControlWork = (
  coordinator: Coordinator,
  duties: Duty[],
  canRun?: () => boolean,
) => { ready: Promise<void> };

describe("durable execution control worker registration", () => {
  it("does not overlap a duty and schedules its next deadline after settlement", async () => {
    const registrations: Array<{ queue: string; worker: Worker }> = [];
    const coordinator: Coordinator = {
      register: (queue, worker) => {
        registrations.push({ queue, worker });
        return { ready: Promise.resolve() };
      },
    };
    const context = {
      EXECUTION_RECONCILIATION_INTERVAL_MS,
      registerExecutionControlWork: undefined as unknown as RegisterExecutionControlWork,
    };
    runInNewContext(wiring, context);

    let finishDuty!: () => void;
    const duty = vi.fn(() => new Promise<void>(resolve => { finishDuty = resolve; }));
    const deadline = Date.now() + 120_000;
    const next = vi.fn(async () => deadline);
    context.registerExecutionControlWork(coordinator, [
      { queue: "execution-continuation", run: duty, next },
    ]);
    const worker = registrations[0]!.worker;
    expect(worker.pausePassiveMaintenance).toBe(true);
    const first = worker.run();
    await worker.run(); // A second tick cannot overlap the in-flight duty.
    expect(duty).toHaveBeenCalledTimes(1);
    finishDuty();
    await first;
    expect(next).toHaveBeenCalledTimes(1);
    await expect(worker.hasPending()).resolves.toBe(false);
    expect(worker.nextRunAt()).toBeGreaterThanOrEqual(deadline);
  });

  it("does not dispatch when its scheduler gate is closed", async () => {
    const registrations: Array<{ queue: string; worker: Worker }> = [];
    const coordinator: Coordinator = {
      register: (queue, worker) => {
        registrations.push({ queue, worker });
        return { ready: Promise.resolve() };
      },
    };
    const context = {
      EXECUTION_RECONCILIATION_INTERVAL_MS,
      registerExecutionControlWork: undefined as unknown as RegisterExecutionControlWork,
    };
    runInNewContext(wiring, context);
    const duty = vi.fn(async () => {});
    const next = vi.fn(async () => null);
    context.registerExecutionControlWork(
      coordinator,
      [{ queue: "execution-continuation", run: duty, next }],
      () => false,
    );
    expect(registrations[0]!.worker.pausePassiveMaintenance).toBe(true);
    await registrations[0]!.worker.run();
    expect(duty).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
