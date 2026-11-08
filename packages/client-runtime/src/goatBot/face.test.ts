import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  FACE_HOLD_MS,
  FINISHED_MS,
  SLEEP_AFTER_MS,
  advanceGoatBotFace,
  faceHoldStep,
  goatBotFace,
  goatBotFaceTasks,
  type GoatBotFaceInput,
  type GoatBotFaceTaskItem,
  type GoatBotFaceShell,
} from "./face.ts";

const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const at = (ms: number) => DateTime.makeUnsafe(ms);

function shell(overrides: Partial<GoatBotFaceShell> = {}): GoatBotFaceShell {
  return {
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    latestRunCompletedAt: null,
    status: "idle",
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    createdAt: at(T0 - 60_000),
    ...overrides,
  };
}

function input(overrides: Partial<GoatBotFaceInput> = {}): GoatBotFaceInput {
  return { activity: null, waitingCount: 0, shell: shell(), tasks: null, ...overrides };
}

const blockingRequest = {
  id: "request" as never,
  kind: "user_input" as const,
  createdAt: at(T0),
  blocking: true,
};

describe("goatBotFace precedence", () => {
  it.each([
    ["waiting from the waiting count", input({ waitingCount: 1 }), "waiting"],
    [
      "waiting from a blocking request",
      input({ shell: shell({ pendingRuntimeRequest: blockingRequest }) }),
      "waiting",
    ],
    [
      "failed when the latest run failed",
      input({ shell: shell({ status: "failed", latestRunCompletedAt: at(T0 - 1_000) }) }),
      "failed",
    ],
    ["reading from the activity", input({ activity: { state: "reading" } }), "reading"],
    ["working from the activity", input({ activity: { state: "working" } }), "working"],
    [
      "working from an active session run",
      input({ shell: shell({ activityRunStatus: "running", status: "running" }) }),
      "working",
    ],
    [
      "finished just after a completed run",
      input({ shell: shell({ status: "completed", latestRunCompletedAt: at(T0 - 1_000) }) }),
      "finished",
    ],
    [
      "sleeping after a long quiet",
      input({ shell: shell({ createdAt: at(T0 - SLEEP_AFTER_MS - 1) }) }),
      "sleeping",
    ],
    ["idle otherwise", input(), "idle"],
    ["idle with no shell and no activity", input({ shell: null }), "idle"],
  ] as const)("%s", (_name, faceInput, expected) => {
    expect(goatBotFace(faceInput, T0).state).toBe(expected);
  });

  it("shows waiting over a running session", () => {
    const face = goatBotFace(
      input({
        waitingCount: 2,
        activity: { state: "working" },
        shell: shell({ activityRunStatus: "running", status: "running" }),
      }),
      T0,
    );
    expect(face.state).toBe("waiting");
  });

  it("ignores requests the run keeps working past", () => {
    const face = goatBotFace(
      input({
        shell: shell({
          activityRunStatus: "running",
          status: "running",
          pendingRuntimeRequest: { ...blockingRequest, blocking: false },
        }),
      }),
      T0,
    );
    expect(face.state).toBe("working");
  });

  it("stops showing a failure once a newer message arrived", () => {
    const face = goatBotFace(
      input({
        shell: shell({
          status: "failed",
          latestRunCompletedAt: at(T0 - 5_000),
          latestUserMessageAt: at(T0 - 1_000),
        }),
      }),
      T0,
    );
    expect(face.state).toBe("idle");
  });
});

describe("goatBotFace timing", () => {
  it("returns to idle when the finished beat ends", () => {
    const completed = T0 - 1_000;
    const finished = input({
      shell: shell({ status: "completed", latestRunCompletedAt: at(completed) }),
    });
    expect(goatBotFace(finished, T0)).toEqual({
      state: "finished",
      changesAt: completed + FINISHED_MS,
    });
    expect(goatBotFace(finished, completed + FINISHED_MS).state).toBe("idle");
  });

  it("falls asleep after SLEEP_AFTER_MS of quiet and says when", () => {
    const quietSince = T0 - 1_000;
    const quiet = input({ shell: shell({ createdAt: at(quietSince) }) });
    expect(goatBotFace(quiet, T0)).toEqual({
      state: "idle",
      changesAt: quietSince + SLEEP_AFTER_MS,
    });
    expect(goatBotFace(quiet, quietSince + SLEEP_AFTER_MS)).toEqual({
      state: "sleeping",
      changesAt: null,
    });
  });

  it("treats missing times as unknown, never as now", () => {
    const face = goatBotFace(
      input({ shell: shell({ status: "completed", latestRunCompletedAt: undefined }) }),
      T0,
    );
    expect(face.state).toBe("idle");
  });
});

describe("faceHoldStep", () => {
  it("keeps working on screen when idle arrives inside the hold", () => {
    const working = faceHoldStep(faceHoldStep(null, "idle", T0), "working", T0 + FACE_HOLD_MS);
    expect(faceHoldStep(working, "idle", T0 + FACE_HOLD_MS + 500).shown).toBe("working");
    expect(faceHoldStep(working, "idle", T0 + 2 * FACE_HOLD_MS).shown).toBe("idle");
  });

  it("shows waiting and failed at once", () => {
    const working = faceHoldStep(faceHoldStep(null, "idle", T0), "working", T0 + FACE_HOLD_MS);
    expect(faceHoldStep(working, "waiting", T0 + FACE_HOLD_MS + 1).shown).toBe("waiting");
    expect(faceHoldStep(working, "failed", T0 + FACE_HOLD_MS + 1).shown).toBe("failed");
  });
});

describe("advanceGoatBotFace", () => {
  it("wakes when the hold expires", () => {
    const working = input({ activity: { state: "working" } });
    const first = advanceGoatBotFace(advanceGoatBotFace(null, input(), T0), working, T0 + 2_000);
    const held = advanceGoatBotFace(first, input(), T0 + 2_100);
    expect(held.hold.shown).toBe("working");
    expect(held.wakeAt).toBe(T0 + 2_000 + FACE_HOLD_MS);
    expect(advanceGoatBotFace(held, input(), T0 + 2_000 + FACE_HOLD_MS).hold.shown).toBe("idle");
  });

  it("wakes at the earliest of the finished beat and the hold", () => {
    const completed = T0 - 3_900;
    const finished = input({
      shell: shell({ status: "completed", latestRunCompletedAt: at(completed) }),
    });
    const track = advanceGoatBotFace(null, finished, T0);
    expect(track.hold.shown).toBe("finished");
    expect(track.wakeAt).toBe(completed + FINISHED_MS);
  });

  it("never schedules a wake in the past", () => {
    const track = advanceGoatBotFace(null, input({ shell: null }), T0);
    expect(track.wakeAt).toBeNull();
  });
});

describe("goatBotFace request and failure rules", () => {
  it("counts a request from an older server without blocking as waiting", () => {
    const { blocking: _blocking, ...older } = blockingRequest;
    expect(goatBotFace(input({ shell: shell({ pendingRuntimeRequest: older }) }), T0).state).toBe(
      "waiting",
    );
  });

  it("keeps a failure whose completion time is unknown", () => {
    expect(goatBotFace(input({ shell: shell({ status: "failed" }) }), T0).state).toBe("failed");
  });
});

describe("goatBotFace from the conversation's task chips", () => {
  const tasks = (overrides: Partial<NonNullable<GoatBotFaceInput["tasks"]>>) => ({
    waiting: 0,
    active: 0,
    ended: null,
    activeSince: null,
    ...overrides,
  });

  it("works while a task runs, though the conversation thread itself never runs", () => {
    expect(goatBotFace(input({ tasks: tasks({ active: 1 }) }), T0).state).toBe("working");
  });

  it("waits while a task waits on the person", () => {
    expect(goatBotFace(input({ tasks: tasks({ waiting: 1, active: 1 }) }), T0).state).toBe(
      "waiting",
    );
  });

  it("shows a failed task until the person writes again", () => {
    const failed = tasks({ ended: { status: "failed", at: T0 - 5_000 } });
    expect(goatBotFace(input({ tasks: failed }), T0).state).toBe("failed");
    const answered = input({
      tasks: failed,
      shell: shell({ latestUserMessageAt: at(T0 - 1_000) }),
    });
    expect(goatBotFace(answered, T0).state).toBe("idle");
  });

  it("is finished for a beat after a task completes", () => {
    const done = tasks({ ended: { status: "completed", at: T0 - 1_000 } });
    expect(goatBotFace(input({ tasks: done }), T0)).toEqual({
      state: "finished",
      changesAt: T0 - 1_000 + FINISHED_MS,
    });
  });
});

describe("goatBotFaceTasks", () => {
  it("reads only each task's newest chip, filtered or not", () => {
    const items = [
      chip("a", 1, "running"),
      chip("a", 2, "waiting_input"),
      chip("b", 1, "waiting_input"),
      chip("b", 2, "completed"),
      chip("c", 1, "running"),
    ];
    expect(goatBotFaceTasks(items)).toEqual({
      waiting: 1,
      active: 1,
      ended: null,
      activeSince: Date.parse("2026-11-07T09:00:00.000Z"),
    });
  });

  it("names the newest ended task once nothing is going", () => {
    const items = [
      chip("a", 1, "completed", "2026-11-07T09:00:00.000Z"),
      chip("b", 1, "failed", "2026-11-07T09:30:00.000Z"),
    ];
    expect(goatBotFaceTasks(items).ended).toEqual({
      status: "failed",
      at: Date.parse("2026-11-07T09:30:00.000Z"),
    });
  });

  it("counts a running turn as waiting when its coding thread asks the person something", () => {
    const items = [
      chip("turn", 1, "running", "2026-11-07T09:00:00.000Z", {
        observed: { needsYou: [{ kind: "question", since: "2026-11-07T09:01:00.000Z" }] },
      }),
      chip("asked", 1, "running", "2026-11-07T09:00:00.000Z", { openQuestionCount: 1 }),
    ];
    const tasks = goatBotFaceTasks(items);
    expect(tasks).toMatchObject({ waiting: 2, active: 0 });
    expect(goatBotFace(input({ tasks }), T0).state).toBe("waiting");
  });

  it("counts a finished task as waiting only while an approval is still open", () => {
    const approval = chip("done", 1, "completed", "2026-11-07T09:00:00.000Z", {
      observed: {
        needsYou: [
          {
            kind: "approval",
            since: "2026-11-07T09:01:00.000Z",
            approval: { requestId: "request:1", threadId: "thread:1" },
          },
        ],
      },
    });
    expect(goatBotFaceTasks([approval])).toMatchObject({ waiting: 1, active: 0, ended: null });
    const question = chip("asked", 1, "completed", "2026-11-07T09:00:00.000Z", {
      observed: { needsYou: [{ kind: "question", since: "2026-11-07T09:01:00.000Z" }] },
    });
    expect(goatBotFaceTasks([question]).waiting).toBe(0);
    expect(goatBotFaceTasks([question]).ended).not.toBeNull();
  });
});

function chip(
  taskId: string,
  taskVersion: number,
  status: string,
  updatedAt = "2026-11-07T09:00:00.000Z",
  extra: Record<string, unknown> = {},
): GoatBotFaceTaskItem {
  return {
    item: {
      type: "notification",
      ledgerTask: {
        taskId,
        taskVersion,
        status,
        createdAt: updatedAt,
        updatedAt,
        openQuestionCount: 0,
        ...extra,
      },
    },
  } as unknown as GoatBotFaceTaskItem;
}
