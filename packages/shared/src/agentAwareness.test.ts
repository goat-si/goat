import { describe, expect, it } from "@effect/vitest";

import type { EnvironmentId, OrchestrationV2ThreadShell, Project, ThreadId } from "@goat/contracts";
import { ProviderInstanceId, RuntimeRequestId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";

import { projectThreadAwarenessV2, subagentRequestAwareness } from "./agentAwareness.ts";

const NOW = "2026-05-22T12:00:00.000Z";

const project = {
  title: "t3code",
} satisfies Pick<Project, "title">;

describe("projectThreadAwarenessV2", () => {
  const updatedAt = DateTime.makeUnsafe(NOW);
  const v2Thread = (
    overrides: Partial<
      Pick<
        OrchestrationV2ThreadShell,
        | "activityRunStatus"
        | "latestRunBackgroundWake"
        | "latestRunStopRequested"
        | "status"
        | "pendingBackgroundTasks"
        | "pendingRuntimeRequest"
        | "lineage"
        | "settledOverride"
      >
    > = {},
  ) => ({
    id: "thread-2" as ThreadId,
    lineage: {
      rootThreadId: "thread-2" as ThreadId,
      parentThreadId: null,
      relationshipToParent: null,
    },
    title: "Integrate orchestration",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    status: "running" as const,
    pendingRuntimeRequest: null,
    settledOverride: null,
    updatedAt,
    ...overrides,
  });

  it("projects a child's approval handoff as an approval, not a question", () => {
    const request = subagentRequestAwareness({
      ...v2Thread({
        lineage: {
          rootThreadId: "thread-2" as ThreadId,
          parentThreadId: "thread-2" as ThreadId,
          relationshipToParent: "subagent",
        },
        activityRunStatus: "running",
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("child-approval"),
          kind: "user_input",
          createdAt: updatedAt,
          blocking: true,
          handoff: { kind: "approval", title: "Join pen-lidge to the hub" },
        },
      }),
      id: "child" as ThreadId,
      creationSource: "mcp",
    });
    expect(request?.phase).toBe("waiting_for_approval");
  });

  it("projects a child question ahead of a completed parent's silent state", () => {
    const request = subagentRequestAwareness({
      ...v2Thread({
        lineage: {
          rootThreadId: "thread-2" as ThreadId,
          parentThreadId: "thread-2" as ThreadId,
          relationshipToParent: "subagent",
        },
        activityRunStatus: "running",
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("child-question"),
          kind: "user_input",
          createdAt: updatedAt,
        },
      }),
      id: "child" as ThreadId,
      creationSource: "mcp",
    });
    expect(request?.phase).toBe("waiting_for_input");
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: { ...v2Thread({ status: "completed" }), latestRunCompletionNotification: "silent" },
        pendingSubagentRequest: request,
      }),
    ).toMatchObject({ threadId: "thread-2", phase: "waiting_for_input" });
  });

  it("removes silent completed activity while preserving live attention and background work", () => {
    const input = {
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: {
        ...v2Thread(),
        status: "completed" as const,
        latestRunCompletionNotification: "silent",
      },
    };
    expect(projectThreadAwarenessV2(input)).toBeNull();
    expect(
      projectThreadAwarenessV2({
        ...input,
        thread: { ...input.thread, activityRunStatus: "running" as const },
      })?.phase,
    ).toBe("running");
    expect(
      projectThreadAwarenessV2({
        ...input,
        thread: {
          ...input.thread,
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("approval"),
            kind: "command",
            createdAt: updatedAt,
          },
        },
      })?.phase,
    ).toBe("waiting_for_approval");
  });

  it("does not announce completion after a manual stop", () => {
    const input = {
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: v2Thread({ status: "completed" }),
    };
    expect(projectThreadAwarenessV2(input)?.phase).toBe("completed");
    expect(
      projectThreadAwarenessV2({
        ...input,
        thread: { ...input.thread, latestRunStopRequested: true },
      }),
    ).toBeNull();
  });

  it.each([
    ["holds a wake run", true, [{ taskId: "watch", kind: "monitor" as const }], "running"],
    ["completes a wake run once its monitor ends", true, [], "completed"],
    [
      "holds a wake run while a monitor remains beside other work",
      true,
      [
        { taskId: "build", kind: "command" as const },
        { taskId: "watch", kind: "monitor" as const },
      ],
      "running",
    ],
    [
      "completes a wake run with only a command pending",
      true,
      [{ taskId: "build", kind: "command" as const }],
      "completed",
    ],
    [
      "completes a run the user started",
      false,
      [{ taskId: "watch", kind: "monitor" as const }],
      "completed",
    ],
  ] as const)("%s while a monitor wakes the thread", (_, latestRunBackgroundWake, tasks, phase) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          status: "completed",
          latestRunBackgroundWake,
          pendingBackgroundTasks: [...tasks],
        }),
      })?.phase,
    ).toBe(phase);
  });

  it.each(["running", "completed", "failed"] as const)(
    "does not publish %s subagent activity",
    (status) => {
      expect(
        projectThreadAwarenessV2({
          environmentId: "env-1" as EnvironmentId,
          project,
          thread: v2Thread({
            status,
            lineage: {
              rootThreadId: "parent" as ThreadId,
              parentThreadId: "parent" as ThreadId,
              relationshipToParent: "subagent",
            },
          }),
        }),
      ).toBeNull();
    },
  );

  it("keeps an older activity run visible over a newer cancelled run", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "cancelled", activityRunStatus: "running" }),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });

  it.each([
    ["completed", "completed", false],
    ["failed", "failed", false],
    ["monitor-held", "completed", true],
  ] as const)("removes settled %s work", (_, status, latestRunBackgroundWake) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          status,
          settledOverride: "settled",
          latestRunBackgroundWake,
          pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor" }],
        }),
      }),
    ).toBeNull();
  });

  it.each(["starting", "running", "waiting"] as const)(
    "keeps settled %s work visible",
    (status) => {
      expect(
        projectThreadAwarenessV2({
          environmentId: "env-1" as EnvironmentId,
          project,
          thread: v2Thread({ status, settledOverride: "settled" }),
        }),
      ).toMatchObject({ phase: status === "starting" ? "starting" : "running" });
    },
  );

  it.each(["user_input", "command"] as const)(
    "keeps a settled terminal thread with a pending %s request",
    (kind) => {
      expect(
        projectThreadAwarenessV2({
          environmentId: "env-1" as EnvironmentId,
          project,
          thread: v2Thread({
            status: "completed",
            settledOverride: "settled",
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("request-settled"),
              kind,
              createdAt: updatedAt,
            },
          }),
        }),
      ).toMatchObject({
        phase: kind === "user_input" ? "waiting_for_input" : "waiting_for_approval",
      });
    },
  );

  it("keeps settled work held open by an awaited monitor", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          status: "completed",
          settledOverride: "settled",
          pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", awaited: true }],
        }),
      }),
    ).toMatchObject({ phase: "running" });
  });

  it.each([
    ["only a dev server", "completed", [{ taskId: "dev", kind: "command" }]],
    ["a dev server's watchdog monitor", "completed", [{ taskId: "watch", kind: "monitor" }]],
    [
      "a command the agent waits on",
      "running",
      [{ taskId: "tests", kind: "command", awaited: true }],
    ],
    [
      "a dev server and a subagent",
      "running",
      [
        { taskId: "dev", kind: "command" },
        { taskId: "review", kind: "subagent" },
      ],
    ],
  ] as const)("reports a completed run waiting on %s as %s", (_case, phase, tasks) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "completed", pendingBackgroundTasks: tasks }),
      }),
    ).toMatchObject({ phase });
  });

  it("reports an async question as input only after the working run completes", () => {
    const input = {
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: v2Thread({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-async"),
          kind: "user_input",
          createdAt: updatedAt,
          blocking: false,
        },
      }),
    };
    expect(projectThreadAwarenessV2(input)).toMatchObject({
      phase: "running",
      headline: "Agent is working",
    });
    expect(
      projectThreadAwarenessV2({ ...input, thread: { ...input.thread, status: "completed" } }),
    ).toMatchObject({ phase: "waiting_for_input", headline: "Waiting for input" });
  });

  it("does not present authentication refreshes as user approvals", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-auth-refresh"),
            kind: "auth_refresh",
            createdAt: updatedAt,
          },
        }),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });

  it("reports a waiting approval handoff as an approval named by its title", () => {
    const state = projectThreadAwarenessV2({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: v2Thread({
        status: "waiting",
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("handoff-1"),
          kind: "user_input",
          createdAt: updatedAt,
          blocking: true,
          handoff: { kind: "approval", title: "Join pen-lidge to the hub" },
        },
      }),
    });
    expect(state?.phase).toBe("waiting_for_approval");
    expect(state?.headline).toBe("Approval needed");
    expect(state?.detail).toBe("Join pen-lidge to the hub");
  });
});
