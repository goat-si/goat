import { scopeProjectRef } from "@goat/client-runtime/environment";
import { EnvironmentId, ProjectId, ProviderInstanceId, type ModelSelection } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  resolveLastWorkTarget,
  resolveNewThreadEnvModeWithLastWork,
  resolveNewThreadModelSelectionOverride,
  startNewThreadFromLastWork,
  type ChatThreadActionContext,
} from "./chatThreadActions";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const FALLBACK_PROJECT_ID = ProjectId.make("project-2");
const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

type LastWorkThread = Parameters<typeof resolveLastWorkTarget>[0][number];
const loadedProjects = [
  { environmentId: ENVIRONMENT_ID, id: PROJECT_ID },
  { environmentId: ENVIRONMENT_ID, id: FALLBACK_PROJECT_ID },
];
function lastWorkThread(overrides: Partial<LastWorkThread> = {}): LastWorkThread {
  return {
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    archivedAt: null,
    latestUserAuthoredMessageAt: "2026-10-10T10:00:00.000Z",
    latestUserMessageAt: "2026-10-10T10:00:00.000Z",
    worktreePath: null,
    ...overrides,
  };
}

describe("chatThreadActions", () => {
  it("selects the newest authored message over newer wake-only activity", () => {
    expect(
      resolveLastWorkTarget(
        [
          lastWorkThread({
            projectId: FALLBACK_PROJECT_ID,
            latestUserAuthoredMessageAt: "2026-10-09T10:00:00.000Z",
            latestUserMessageAt: "2026-10-11T10:00:00.000Z",
          }),
          lastWorkThread({ worktreePath: "/worktree" }),
        ],
        loadedProjects,
      ),
    ).toEqual({ projectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), envMode: "worktree" });
  });

  it("ignores archived threads and threads whose scoped project is not loaded", () => {
    expect(
      resolveLastWorkTarget(
        [
          lastWorkThread({
            archivedAt: "2026-10-12T10:00:00.000Z",
            latestUserAuthoredMessageAt: "2026-10-12T10:00:00.000Z",
          }),
          lastWorkThread({
            environmentId: EnvironmentId.make("another-environment"),
            latestUserAuthoredMessageAt: "2026-10-11T10:00:00.000Z",
          }),
          lastWorkThread({ projectId: FALLBACK_PROJECT_ID }),
        ],
        loadedProjects,
      ),
    ).toEqual({
      projectRef: scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
      envMode: "local",
    });
  });

  it("uses the legacy timestamp only when authored time is undefined", () => {
    expect(
      resolveLastWorkTarget(
        [
          lastWorkThread({
            latestUserAuthoredMessageAt: null,
            latestUserMessageAt: "2026-10-12T10:00:00.000Z",
          }),
          {
            environmentId: ENVIRONMENT_ID,
            projectId: FALLBACK_PROJECT_ID,
            archivedAt: null,
            latestUserMessageAt: "2026-10-11T10:00:00.000Z",
            worktreePath: null,
          },
        ],
        loadedProjects,
      ),
    ).toEqual({
      projectRef: scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
      envMode: "local",
    });
    expect(
      resolveLastWorkTarget(
        [lastWorkThread({ latestUserAuthoredMessageAt: null })],
        loadedProjects,
      ),
    ).toBeNull();
    expect(resolveLastWorkTarget([], loadedProjects)).toBeNull();
  });

  it("passes last work as a workspace mode hint without carrying the worktree path", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});
    expect(
      await startNewThreadFromLastWork({
        threads: [lastWorkThread({ worktreePath: "/worktree" })],
        projects: loadedProjects,
        handleNewThread,
      }),
    ).toBe(true);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      lastWorkEnvMode: "worktree",
    });
  });

  it("lets project and t3.json modes beat last work, but uses the hint for environment defaults", () => {
    for (const resolvedSource of ["project", "t3.json"] as const) {
      expect(
        resolveNewThreadEnvModeWithLastWork({
          resolvedSource,
          resolvedMode: "local",
          lastWorkEnvMode: "worktree",
        }),
      ).toBe("local");
    }
    expect(
      resolveNewThreadEnvModeWithLastWork({
        resolvedSource: "environment",
        resolvedMode: "local",
        lastWorkEnvMode: "worktree",
      }),
    ).toBe("worktree");
    expect(
      resolveNewThreadEnvModeWithLastWork({
        resolvedSource: "environment",
        resolvedMode: "local",
        lastWorkEnvMode: undefined,
      }),
    ).toBe("local");
  });

  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });
});
