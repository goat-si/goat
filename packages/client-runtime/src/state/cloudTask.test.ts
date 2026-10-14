import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2CloudTask,
} from "@goat/contracts";
import { deriveCloudTaskState, presentCloudTask } from "./cloudTask.ts";

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
