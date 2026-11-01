import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ChannelTask,
  ChannelTaskChip,
  ChannelTaskEvent,
  ChannelTimelineRecord,
  ChannelWorkerRun,
  isChannelTaskTerminal,
} from "./index.ts";

const decodeTaskEvent = Schema.decodeUnknownSync(ChannelTaskEvent);
const decodeTask = Schema.decodeUnknownSync(ChannelTask);

const roundTrip = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: unknown) => {
  const json = Schema.toCodecJson(schema);
  const decoded = Schema.decodeUnknownSync(json)(value);
  const encoded = Schema.encodeSync(json)(decoded);
  expect(Schema.decodeSync(json)(encoded)).toEqual(decoded);
  return decoded;
};

const requester = {
  ownerId: "owner",
  principalId: "owner",
  displayName: "Jun",
  originKind: "slack",
  externalActorId: "U123",
  runtimeModeCeiling: "approval-required",
  grantedScopes: ["orchestration:read"],
};

const task = {
  taskId: "task-1",
  conversationId: "conv-1",
  originBindingId: "binding-1",
  originAddress: {
    kind: "slack",
    connectionId: "slack-1",
    teamId: "T1",
    channelId: "C1",
    rootTs: "1760000000.000100",
  },
  originInputId: "input-1",
  requester,
  title: "Re-verify the Opus 5.5 call",
  instruction: "Run the call again and report the latency.",
  status: "running",
  version: 3,
  generation: 1,
  worker: { environmentId: "env-1", threadId: "worker-thread", runId: "run-1", generation: 1 },
  openQuestions: [],
  createdAt: "2026-10-12T00:00:00.000Z",
  updatedAt: "2026-10-12T00:00:05.000Z",
};

describe("channel tasks", () => {
  it("round-trips a task with its fixed origin and requester snapshot", () => {
    expect(roundTrip(ChannelTask, task).briefVersion).toBeUndefined();
    expect(roundTrip(ChannelTask, { ...task, briefVersion: 2 }).briefVersion).toBe(2);
    expect(roundTrip(ChannelTask, task)).toMatchObject({
      originAddress: task.originAddress,
      requester: { externalActorId: "U123" },
    });
  });

  it("keeps tasks without a remote worker as they were and round-trips a remote one", () => {
    const local = roundTrip(ChannelTask, task);
    expect(local.host).toBeUndefined();
    expect(local.worker?.host).toBeUndefined();
    const target = {
      environmentId: "env-remote",
      projectId: "remote-project",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspaceStrategy: { type: "worktree" },
    };
    expect(roundTrip(ChannelTask, { ...task, target }).target?.remote).toBeUndefined();
    const remote = roundTrip(ChannelTask, {
      ...task,
      host: "mac-studio",
      target: { ...target, remote: { host: "mac-studio", cwd: "/Users/jun/developer/goat" } },
      worker: { ...task.worker, environmentId: "env-remote", host: "mac-studio" },
    });
    expect(remote).toMatchObject({
      host: "mac-studio",
      target: { remote: { host: "mac-studio", cwd: "/Users/jun/developer/goat" } },
      worker: { host: "mac-studio" },
    });
    expect(() =>
      decodeTask({
        ...task,
        target: { ...target, remote: { host: "mac-studio" } },
      }),
    ).toThrow();
  });

  it("round-trips old and new task claims without inventing a memory grant or note permission", () => {
    const target = {
      environmentId: "env-1",
      projectId: "project-1",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
    };
    const base = {
      eventId: "claim-1",
      sequence: 2,
      taskId: task.taskId,
      taskVersion: 2,
      occurredAt: task.createdAt,
      actor: "system",
    };
    const claim = {
      ...base,
      type: "task.dispatch.claimed",
      payload: { generation: 1, target, leaseExpiresAt: task.createdAt },
    };
    expect(roundTrip(ChannelTask, { ...task, target }).target).not.toHaveProperty(
      "memoryGrantCeiling",
    );
    expect(roundTrip(ChannelTask, task)).not.toHaveProperty("notesChangeRequested");
    expect(roundTrip(ChannelTaskEvent, claim)).toEqual(claim);
    const created = {
      ...base,
      type: "task.created",
      payload: {
        title: task.title,
        instruction: task.instruction,
        originInputId: task.originInputId,
      },
    };
    expect(roundTrip(ChannelTaskEvent, created)).toEqual(created);
    const notesChangeRequested = "forget the Korean note";
    expect(roundTrip(ChannelTask, { ...task, notesChangeRequested }).notesChangeRequested).toBe(
      notesChangeRequested,
    );
    expect(
      roundTrip(ChannelTaskEvent, {
        ...created,
        payload: { ...created.payload, notesChangeRequested },
      }),
    ).toMatchObject({ payload: { notesChangeRequested } });
    for (const memoryGrantCeiling of ["none", "read", "read_write"] as const) {
      const withMemory = { ...target, memoryGrantCeiling };
      expect(
        roundTrip(ChannelTask, { ...task, target: withMemory }).target?.memoryGrantCeiling,
      ).toBe(memoryGrantCeiling);
      expect(
        roundTrip(ChannelTaskEvent, {
          ...claim,
          payload: { ...claim.payload, target: withMemory },
        }),
      ).toMatchObject({ payload: { target: { memoryGrantCeiling } } });
    }
    expect(() =>
      decodeTask({ ...task, target: { ...target, memoryGrantCeiling: "write" } }),
    ).toThrow();
  });

  it("round-trips a move and the copy provenance on tasks and chips", () => {
    const replicaCapturedAt = "2026-10-12T00:00:04.000Z";
    const movedFrom = { host: "mac-studio", generation: 1, at: task.updatedAt, replicaCapturedAt };
    expect(
      roundTrip(ChannelTaskEvent, {
        eventId: "move-1",
        sequence: 4,
        taskId: task.taskId,
        taskVersion: 4,
        occurredAt: task.updatedAt,
        actor: "user",
        type: "task.moved",
        payload: { generation: 2, host: "mini", fromHost: "mac-studio", replicaCapturedAt },
      }),
    ).toMatchObject({ type: "task.moved", payload: { generation: 2, replicaCapturedAt } });
    expect(roundTrip(ChannelTask, { ...task, movedFrom }).movedFrom).toEqual(movedFrom);
    expect(
      roundTrip(ChannelTaskChip, {
        taskId: task.taskId,
        conversationId: task.conversationId,
        taskVersion: 4,
        title: task.title,
        status: "received",
        originKind: "slack",
        requesterLabel: "Jun",
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        openQuestionCount: 0,
        movedFrom,
      }).movedFrom,
    ).toEqual(movedFrom);
  });

  it("treats only completed, failed, and cancelled as terminal", () => {
    expect(
      (["received", "dispatching", "running", "waiting_input"] as const).map(isChannelTaskTerminal),
    ).toEqual([false, false, false, false]);
    expect((["completed", "failed", "cancelled"] as const).map(isChannelTaskTerminal)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("types each event payload by its top-level type", () => {
    const base = {
      eventId: "event-1",
      sequence: 7,
      taskId: "task-1",
      taskVersion: 4,
      occurredAt: "2026-10-12T00:00:06.000Z",
      actor: "agent",
    };
    const completed = roundTrip(ChannelTaskEvent, {
      ...base,
      type: "task.completed",
      payload: { generation: 1, runId: "run-1", summary: "Latency 1.2s", briefVersion: 1 },
    });
    expect(completed).toMatchObject({
      type: "task.completed",
      payload: { summary: "Latency 1.2s", briefVersion: 1 },
    });
    // A payload that belongs to another event type does not decode.
    expect(() =>
      decodeTaskEvent({
        ...base,
        type: "task.completed",
        payload: { worker: task.worker },
      }),
    ).toThrow();
    expect(() => decodeTaskEvent({ ...base, type: "task.deleted", payload: {} })).toThrow();
  });
});

describe("timeline records", () => {
  it("carries either a bot message or a task chip", () => {
    const chip = {
      taskId: "task-1",
      conversationId: "conv-1",
      taskVersion: 3,
      title: "Re-verify the Opus 5.5 call",
      status: "running",
      originKind: "slack",
      requesterLabel: "Jun",
      createdAt: "2026-10-12T00:00:00.000Z",
      updatedAt: "2026-10-12T00:00:05.000Z",
      worker: { environmentId: "env-1", threadId: "worker-thread" },
      openQuestionCount: 0,
    };
    expect(roundTrip(ChannelTaskChip, chip)).toEqual(chip);
    const remoteChip = {
      ...chip,
      worker: { environmentId: "env-remote", threadId: "worker-thread", host: "mac-studio" },
    };
    expect(roundTrip(ChannelTaskChip, remoteChip)).toEqual(remoteChip);
    expect(
      roundTrip(ChannelTimelineRecord, {
        recordKey: "task-chip:task-1",
        entry: { type: "task_chip", chip },
      }),
    ).toMatchObject({ entry: { chip: { worker: { threadId: "worker-thread" } } } });
    expect(
      roundTrip(ChannelTimelineRecord, {
        recordKey: "reply:input-1",
        entry: {
          type: "message",
          role: "assistant",
          text: "On it.",
          meta: {
            conversationId: "conv-1",
            originKind: "goat",
            kind: "receipt",
            inReplyToInputId: "input-1",
          },
        },
      }),
    ).toMatchObject({ entry: { meta: { inReplyToInputId: "input-1" } } });
  });
});

describe("channel worker runs", () => {
  const run = {
    runId: "run-1",
    taskId: "task-1",
    generation: 1,
    threadId: "thread-1",
    status: "running",
    startedAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
  };

  it("decodes a run stored before stalled existed, and a stalled run", () => {
    expect(roundTrip(ChannelWorkerRun, run).status).toBe("running");
    const stalled = roundTrip(ChannelWorkerRun, { ...run, status: "stalled" });
    expect(stalled.status).toBe("stalled");
    expect(stalled.endedAt).toBeUndefined();
  });
});
