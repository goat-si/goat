import { WsRpcGroup, WS_METHODS } from "./rpc.ts";
import { MemoryTaskGrantCeilingField } from "./memory.ts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTask,
  ScheduledTaskUpsertInput,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });
});

it.each(["literal", " ", "\t\n", "{{body.bad", "{{unknown.field}}"])(
  "rejects invalid dedupe template %s",
  (replayKey) => {
    expect(() => decodeUpsertSchedule({ type: "webhook", dedupe: { replayKey } })).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "webhook", dedupe: { coalesceKey: replayKey } }),
    ).toThrow();
  },
);
describe("webhook filters", () => {
  const accepts = (filters: unknown) => {
    try {
      decodeUpsertSchedule({ type: "webhook", filters });
      return true;
    } catch {
      return false;
    }
  };

  it("rejects empty or unknown paths, unknown ops, and values that do not fit the op", () => {
    expect(accepts([{ path: "", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "  ", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "request", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "header.x-github-event", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: "opened" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: [] }])).toBe(false);
    for (const value of ["", " opened", "opened ", "a,b"]) {
      expect(accepts([{ path: "body.action", op: "in", value: [value] }])).toBe(false);
    }
    expect(accepts([{ path: "body.label.name", op: "in", value: ["needs review"] }])).toBe(true);
    expect(accepts([{ path: "body.action", op: "equals" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "matches", value: "^opened$" }])).toBe(false);
  });
});

describe("persisted task memory ceiling", () => {
  it("omits default ceilings from JSON and preserves explicit access ceilings", () => {
    const row = {
      id: "task",
      title: "Synthetic schedule",
      prompt: "Synthetic prompt",
      enabled: true,
      schedule: { type: "interval", everyMs: 60000 },
      projectId: "project",
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-15T00:00:00.000Z",
      updatedAt: "2026-10-15T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
    };
    const persisted = Schema.decodeUnknownSync(ScheduledTask)(row);
    expect(persisted.memoryGrantCeiling).toBe("none");
    expect(persisted).not.toHaveProperty("currentMemoryAccess");
    const assessment = { access: "read", reason: "read_only_destination" } as const;
    const current = Schema.decodeUnknownSync(ScheduledTask)({
      ...row,
      currentMemoryAccess: assessment,
    });
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(ScheduledTask))(
        Schema.encodeSync(Schema.fromJsonString(ScheduledTask))(current),
      ).currentMemoryAccess,
    ).toEqual(assessment);
    expect(() =>
      Schema.decodeUnknownSync(ScheduledTask)({
        ...row,
        currentMemoryAccess: { access: "write", reason: "ceiling" },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ScheduledTask)({
        ...row,
        currentMemoryAccess: { access: "none", reason: "/private/path" },
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(ScheduledTask))(
        Schema.encodeSync(Schema.fromJsonString(ScheduledTask))(persisted),
      ).memoryGrantCeiling,
    ).toBe("none");
    expect(() =>
      Schema.decodeUnknownSync(ScheduledTaskUpsertInput)({
        ...row,
        memoryGrantCeiling: "read_write",
      }),
    ).toThrow();
    const codec = Schema.Struct({ memoryGrantCeiling: MemoryTaskGrantCeilingField });
    expect(Schema.decodeUnknownSync(codec)({})).toEqual({ memoryGrantCeiling: "none" });
    expect(Schema.encodeSync(codec)({})).toEqual({});
    expect(
      JSON.parse(Schema.encodeSync(Schema.fromJsonString(ScheduledTask))(persisted)),
    ).not.toHaveProperty("memoryGrantCeiling");
    for (const memoryGrantCeiling of ["none", "read", "read_write"] as const) {
      expect(Schema.decodeUnknownSync(codec)({ memoryGrantCeiling })).toEqual({
        memoryGrantCeiling,
      });
      expect(Schema.encodeSync(codec)({ memoryGrantCeiling })).toEqual(
        memoryGrantCeiling === "none" ? {} : { memoryGrantCeiling },
      );
      const json = Schema.fromJsonString(ScheduledTask);
      const task = Schema.decodeUnknownSync(ScheduledTask)({ ...row, memoryGrantCeiling });
      const encoded = Schema.encodeSync(json)(task);
      if (memoryGrantCeiling === "none") {
        expect(JSON.parse(encoded)).not.toHaveProperty("memoryGrantCeiling");
      } else {
        expect(JSON.parse(encoded)).toHaveProperty("memoryGrantCeiling", memoryGrantCeiling);
      }
      expect(Schema.decodeUnknownSync(json)(encoded).memoryGrantCeiling).toBe(memoryGrantCeiling);
    }
    const rpc = WsRpcGroup.requests.get(WS_METHODS.scheduledTasksUpsert)!;
    const decodeRpc = Schema.decodeUnknownSync(Schema.fromJsonString(rpc.payloadSchema));
    const publicInput = {
      title: row.title,
      prompt: row.prompt,
      enabled: true,
      schedule: row.schedule,
      projectId: row.projectId,
      workspaceStrategy: row.workspaceStrategy,
      modelSelection: row.modelSelection,
      runtimeMode: row.runtimeMode,
      interactionMode: row.interactionMode,
    };
    expect(decodeRpc(JSON.stringify(publicInput))).toHaveProperty("title", row.title);
    for (const memoryGrantCeiling of ["none", "read", "read_write"])
      expect(() => decodeRpc(JSON.stringify({ ...publicInput, memoryGrantCeiling }))).toThrow();
    expect(() => Schema.decodeUnknownSync(codec)({ memoryGrantCeiling: "full-access" })).toThrow();
  });
});

describe("scheduled run outcomes", () => {
  const task = {
    id: "task",
    title: "Synthetic schedule",
    prompt: "Synthetic prompt",
    enabled: true,
    schedule: { type: "interval", everyMs: 60000 },
    projectId: "project",
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "running",
    lastRunError: null,
    runCount: 1,
  };
  const codec = Schema.fromJsonString(ScheduledTask);
  it("accepts a legacy task without lastRun", () => {
    expect(Schema.decodeUnknownSync(ScheduledTask)(task)).not.toHaveProperty("lastRun");
  });
  it.each([
    "dispatching",
    "queued",
    "running",
    "completed",
    "failed",
    "interrupted",
    "cancelled",
    "rolled_back",
    "unknown",
  ])("round-trips scheduled outcome %s through task JSON", (status) => {
    const lastRun = {
      firingId: "firing",
      dispatchStatus: "accepted",
      status,
      threadId: "thread",
      runId: "run",
      requestedAt: task.createdAt,
      dispatchedAt: task.createdAt,
      startedAt: null,
      completedAt: null,
    };
    const decoded = Schema.decodeUnknownSync(ScheduledTask)({ ...task, lastRun });
    const old = ScheduledTask.mapFields(({ lastRun: _lastRun, ...fields }) => fields);
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(old))(Schema.encodeSync(codec)(decoded))
        .lastRunStatus,
    ).toBe("running");
    expect(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(decoded)).lastRun).toEqual(
      lastRun,
    );
  });
  it("keeps a task when a future nested outcome is unknown", () => {
    expect(
      Schema.decodeUnknownSync(ScheduledTask)({ ...task, lastRun: { status: "future" } }).lastRun,
    ).toBeUndefined();
  });
  it("ignores client-supplied lastRun on task mutation", () => {
    const input = Schema.decodeUnknownSync(ScheduledTaskUpsertInput)({
      ...task,
      lastRun: { status: "completed" },
      firingId: "forged",
    });
    expect(input).not.toHaveProperty("lastRun");
    expect(input).not.toHaveProperty("firingId");
  });
  it("old schema decodes new-server output", () => {
    const old = ScheduledTask.mapFields(({ lastRun: _lastRun, ...fields }) => fields);
    const output = Schema.decodeUnknownSync(ScheduledTask)(task);
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(old))(Schema.encodeSync(codec)(output))
        .lastRunStatus,
    ).toBe("running");
  });
});
