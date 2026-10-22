import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2CloudTask,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { deriveCloudTaskState, presentCloudRun, presentCloudTask } from "./cloudTask.ts";

const instanceId = ProviderInstanceId.make("fakeCloud");
const task: OrchestrationV2CloudTask = {
  taskId: "native-1",
  status: "running",
  tracking: "link-only",
  url: "https://example.com/tasks/1",
  source: { repository: "https://github.com/acme/repo", branch: "dev" },
  localChangesExcluded: true,
  updatedAt: "2026-10-13T00:00:00.000Z",
};
function projection(withTask = true): OrchestrationV2ThreadProjection {
  return {
    thread: { providerInstanceId: instanceId },
    runs: [{ id: "run:1", providerInstanceId: instanceId, status: "starting" }],
    providerThreads: [
      {
        id: "pt:1",
        ownerNodeId: null,
        providerInstanceId: instanceId,
        providerSessionId: "ps:1",
        ...(withTask ? { cloudTask: task } : {}),
      },
    ],
    providerSessions: [
      {
        id: "ps:1",
        capabilities: {
          sessions: {
            executionLocation: "cloud",
            followUp: { supported: false, reason: "No CLI follow-up" },
          },
        },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
}
describe("cloud task client state", () => {
  it("keeps legacy drafts local and allows the first cloud draft", () => {
    expect(deriveCloudTaskState(null)).toEqual({
      cloudTask: null,
      executionLocation: "local",
      launchSourceNotice: null,
      composerBlockReason: null,
      showLocalWorkspace: true,
    });
    expect(
      deriveCloudTaskState(null, {
        instanceId,
        driver: ProviderDriverKind.make("fakeCloud"),
        executionLocation: "cloud",
      }),
    ).toEqual({
      cloudTask: null,
      executionLocation: "cloud",
      launchSourceNotice: null,
      composerBlockReason: null,
      showLocalWorkspace: false,
    });
  });
  it("blocks one-shot follow-ups at admission even before a task ID is known", () => {
    expect(deriveCloudTaskState(projection(false)).composerBlockReason).toBe("No CLI follow-up");
    expect(deriveCloudTaskState(projection()).showLocalWorkspace).toBe(false);
  });
  it("shows link-only as running and keeps task/PR URLs optional and safe", () => {
    expect(presentCloudTask(task).label).toBe("Running in the cloud");
    expect(presentCloudTask(task).taskUrl).toBe(task.url);
    expect(presentCloudTask({ ...task, url: "javascript:alert(1)" }).taskUrl).toBeNull();
    expect(
      presentCloudTask({ ...task, url: "https://user:secret@example.com/task" }).taskUrl,
    ).toBeNull();
  });
  it("omits accepted run ownership from presentation without emitting undefined", () => {
    const view = presentCloudTask({ ...task, acceptedAppRunId: RunId.make("run:accepted") });
    expect(view).toEqual({
      label: "Running in the cloud",
      taskUrl: task.url,
      prUrl: null,
      localChangesNotice: "local changes are not included",
    });
    expect(Object.hasOwn(view, "acceptedAppRunId")).toBe(false);
    expect(Object.values(view)).not.toContain(undefined);
  });
  it("warns that project-folder tasks may include local changes and retains legacy exclusions", () => {
    expect(
      presentCloudTask({ ...task, localChangesExcluded: false, localChangesIncluded: true })
        .localChangesNotice,
    ).toBe("local changes may be included");
    expect(presentCloudTask(task).localChangesNotice).toBe("local changes are not included");
    expect(
      presentCloudTask({ ...task, localChangesExcluded: false, localChangesIncluded: false })
        .localChangesNotice,
    ).toBeNull();
    expect(
      presentCloudTask({ ...task, localChangesExcluded: false }).localChangesNotice,
    ).toBeNull();
  });
  it("blocks unknown acceptance with its persisted recovery reason", () => {
    const current = projection();
    const unknown = {
      ...current,
      providerThreads: current.providerThreads.map((thread) => ({
        ...thread,
        cloudTask: {
          ...task,
          status: "unknown" as const,
          error: "Open the saved task before continuing.",
        },
      })),
    };
    expect(deriveCloudTaskState(unknown).composerBlockReason).toBe(
      "Open the saved task before continuing.",
    );
  });
  it("uses the selected provider for admission while retaining the active cloud result", () => {
    const current = projection();
    const localId = ProviderInstanceId.make("codex");
    const state = deriveCloudTaskState(current, {
      instanceId: localId,
      driver: ProviderDriverKind.make("codex"),
      executionLocation: "local",
    });
    expect(state.composerBlockReason).toBeNull();
    expect(state.cloudTask).toEqual(task);
    expect(state.showLocalWorkspace).toBe(false);
  });
  it("warns before a Claude Cloud draft has a projection or task", () => {
    const notice =
      "Claude Cloud starts tasks from the project folder. Local changes may be included.";
    expect(
      deriveCloudTaskState(null, {
        instanceId,
        driver: ProviderDriverKind.make("claudeCloud"),
        executionLocation: "cloud",
      }).launchSourceNotice,
    ).toBe(notice);
    const current = projection(false);
    const projectFolder = {
      ...current,
      providerSessions: current.providerSessions.map((session) => ({
        ...session,
        capabilities: {
          ...session.capabilities,
          sessions: {
            ...session.capabilities.sessions,
            sourceRestriction: "project-folder" as const,
          },
        },
      })),
    };
    expect(deriveCloudTaskState(projectFolder).launchSourceNotice).toBe(notice);
    for (const driver of ["codex", "claudeAgent", "cursorCloud"]) {
      expect(
        deriveCloudTaskState(projectFolder, {
          instanceId,
          driver: ProviderDriverKind.make(driver),
          executionLocation: driver === "cursorCloud" ? "cloud" : "local",
        }).launchSourceNotice,
      ).toBeNull();
    }
    expect(
      deriveCloudTaskState(projectFolder, {
        instanceId: ProviderInstanceId.make("other-local"),
        driver: ProviderDriverKind.make("codex"),
        executionLocation: "local",
      }).launchSourceNotice,
    ).toBeNull();
  });
  it.each([true, false, undefined])(
    "keeps the selected launch policy independent of inclusion %s",
    (included) => {
      const current = projection();
      const withFlag = {
        ...current,
        providerThreads: current.providerThreads.map((thread) => ({
          ...thread,
          cloudTask: {
            ...task,
            ...(included === undefined ? {} : { localChangesIncluded: included }),
          },
        })),
      };
      expect(
        deriveCloudTaskState(withFlag, {
          instanceId,
          driver: ProviderDriverKind.make("claudeCloud"),
          executionLocation: "cloud",
        }).launchSourceNotice,
      ).toBe("Claude Cloud starts tasks from the project folder. Local changes may be included.");
    },
  );
  it("keeps a confirmed preflight failure retryable and labels correlated PR artifacts", () => {
    const current = projection(false);
    const rejected = {
      ...current,
      runs: current.runs.map((run) => ({ ...run, status: "failed" as const, startedAt: null })),
    };
    expect(deriveCloudTaskState(rejected).composerBlockReason).toBeNull();
    expect(
      presentCloudTask({
        ...task,
        status: "succeeded",
        prUrl: "https://github.com/acme/repo/pull/1",
      }).label,
    ).toBe("Result PR found");
  });
});

describe("presentCloudRun", () => {
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const runId = RunId.make("run:1");
  const failedTask: OrchestrationV2CloudTask = {
    taskId: "run-92d4",
    acceptedAppRunId: runId,
    url: "https://cursor.com/agents/bc-1",
    status: "failed",
    tracking: "live",
    progress: "Cursor Cloud reported an error. Open the agent for details.",
    summary: "Cursor Cloud failed. Open the agent for details.",
    source: { repository: "https://github.com/goat-si/goat", branch: "main" },
    localChangesExcluded: false,
    error: "Cursor reported a terminal cloud error.",
    updatedAt: "2026-10-22T17:40:29.222Z",
  };
  function cloudProjection(input: {
    readonly driver?: string;
    readonly task?: OrchestrationV2CloudTask;
    readonly run?: Record<string, unknown>;
    readonly extraRuns?: ReadonlyArray<Record<string, unknown>>;
  }) {
    const run = {
      id: runId,
      ordinal: 1,
      providerThreadId: "pt:1",
      userMessageId: "message:user-1",
      status: "failed",
      modelSelection: { instanceId: "cursorCloud", model: "auto" },
      requestedAt: at("2026-10-22T17:39:56.000Z"),
      startedAt: at("2026-10-22T17:39:57.000Z"),
      completedAt: at("2026-10-22T17:40:29.000Z"),
      ...input.run,
    };
    return {
      runs: [run, ...(input.extraRuns ?? [])],
      providerThreads: [
        {
          id: "pt:1",
          driver: input.driver ?? "cursorCloud",
          ownerNodeId: null,
          ...(input.task ? { cloudTask: input.task } : {}),
        },
      ],
      turnItems: [
        {
          id: "turn-item:user-1",
          type: "user_message",
          runId,
          parentItemId: null,
          messageId: "message:user-1",
          text: "Fix the flaky test",
          attachments: [],
        },
        {
          id: "turn-item:prep",
          type: "command_execution",
          runId,
          parentItemId: null,
          input: "Preparing workspace",
        },
        {
          id: "turn-item:error",
          type: "error",
          runId,
          parentItemId: null,
          status: "failed",
          failure: { class: "provider_error", message: "Provider turn failed.", code: null },
        },
      ],
    } as unknown as Parameters<typeof presentCloudRun>[0];
  }

  it("collapses a failed Cursor run into one message, hides the duplicates and offers Retry", () => {
    const card = presentCloudRun(cloudProjection({ task: failedTask }))!;
    expect(card.title).toBe("Cursor Cloud stopped with an error");
    expect(card.message).toBe("Cursor reported a terminal cloud error.");
    expect(card.stages.map((stage) => [stage.id, stage.status])).toEqual([
      ["prepare", "done"],
      ["submit", "done"],
      ["run", "failed"],
      ["result", "failed"],
    ]);
    expect(card.stages.find((stage) => stage.id === "run")?.detail).toBeNull();
    expect([...card.hiddenItemIds].sort()).toEqual([
      "turn-item:cloud-result:run:1",
      "turn-item:error",
      "turn-item:prep",
    ]);
    expect([...card.hiddenMessageIds]).toEqual(["message:cloud-result:run:1"]);
    expect(card.taskUrl).toBe("https://cursor.com/agents/bc-1");
    expect(card.retry).toMatchObject({ runId, text: "Fix the flaky test" });
  });

  it("shows live progress while a Claude task runs without acceptance ownership", () => {
    const card = presentCloudRun(
      cloudProjection({
        driver: "claudeCloud",
        task: {
          ...failedTask,
          acceptedAppRunId: undefined,
          status: "running",
          progress: "Running tests.",
          error: undefined,
        },
        run: { status: "running", completedAt: null },
      }),
    )!;
    expect(card.phase).toBe("running");
    expect(card.title).toBe("Claude Cloud is working");
    expect(card.message).toBeNull();
    expect(card.stages.find((stage) => stage.id === "run")).toMatchObject({
      status: "running",
      detail: "Running tests.",
    });
    expect(card.retry).toBeNull();
  });

  it("ignores the previous task while a follow-up waits to start", () => {
    const card = presentCloudRun(
      cloudProjection({
        task: failedTask,
        run: { status: "preparing", startedAt: null, completedAt: null },
      }),
    )!;
    expect(card.phase).toBe("running");
    expect(card.stages.map((stage) => stage.status)).toEqual([
      "running",
      "pending",
      "pending",
      "pending",
    ]);
    expect(card.taskUrl).toBeNull();
  });

  it("names a run that stopped before it was sent", () => {
    const projection = cloudProjection({
      run: { status: "cancelled", startedAt: null },
    }) as unknown as { turnItems: unknown[] };
    projection.turnItems = projection.turnItems.filter(
      (item) => (item as { type: string }).type !== "error",
    );
    const card = presentCloudRun(projection as unknown as Parameters<typeof presentCloudRun>[0])!;
    expect(card.phase).toBe("cancelled");
    expect(card.message).toBe("Stopped before it was sent.");
    expect(card.stages[0]?.status).toBe("skipped");
  });

  it("withholds Retry when the outcome is unknown or another run is active", () => {
    const unknown = presentCloudRun(
      cloudProjection({
        task: { ...failedTask, status: "unknown", error: "Submission outcome is unknown." },
      }),
    )!;
    expect(unknown.retry).toBeNull();
    expect(unknown.message).toBe("Submission outcome is unknown.");
    const queued = presentCloudRun(
      cloudProjection({
        task: failedTask,
        extraRuns: [{ id: "run:0", ordinal: 0, status: "queued", providerThreadId: "pt:1" }],
      }),
    )!;
    expect(queued.retry).toBeNull();
  });

  it("keeps the result message of a finished run and links its pull request", () => {
    const card = presentCloudRun(
      cloudProjection({
        driver: "devinCloud",
        task: {
          ...failedTask,
          status: "succeeded",
          error: undefined,
          prUrl: "https://github.com/goat-si/goat/pull/9",
        },
        run: { status: "completed" },
      }),
    )!;
    expect(card.title).toBe("Devin Cloud finished");
    expect(card.message).toBeNull();
    expect(card.hiddenMessageIds.size).toBe(0);
    expect(card.prUrl).toBe("https://github.com/goat-si/goat/pull/9");
    expect(card.stages.at(-1)).toMatchObject({ label: "Pull request ready", status: "done" });
  });

  it("blames the submission when the provider never accepted the task", () => {
    const card = presentCloudRun(
      cloudProjection({
        driver: "claudeCloud",
        task: {
          ...failedTask,
          taskId: runId,
          acceptedAppRunId: undefined,
          url: undefined,
          error: "Claude Code hasn't trusted this folder yet.",
        },
      }),
    )!;
    expect(card.stages.map((stage) => [stage.id, stage.status])).toEqual([
      ["prepare", "done"],
      ["submit", "failed"],
      ["run", "skipped"],
      ["result", "failed"],
    ]);
    expect(card.message).toBe("Claude Code hasn't trusted this folder yet.");
  });

  it("leaves local runs alone", () => {
    expect(presentCloudRun(cloudProjection({ driver: "codex" }))).toBeNull();
  });
});
