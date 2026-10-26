import { presentThreadShell } from "@goat/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  archiveSelectedThreadEntries,
  deleteSelectedThreadEntries,
  getFallbackThreadIdAfterDelete,
  hasUnseenCompletion,
  resolveSidebarRowThreadId,
  orderItemsByPreferredIds,
  pinOrderKeyBetween,
  resolveProjectStatusIndicator,
  resolveSidebarSweepKeys,
  resolveSidebarThreadStatus,
  resolveSidebarV2TopStatus,
  resolveThreadStatusPill,
  searchSidebarThreads,
  shouldRecedeSidebarThread,
  resolveSidebarDropTarget,
  planSidebarThreadDrop,
  sortPinnedThreadsForSidebar,
  sortProjectsForSidebar,
  sortScopedProjectsForSidebar,
  sortSidebarV2ProjectGroups,
  shouldNavigateAfterThreadPark,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
  resolveSidebarDropVerb,
  sidebarFolderName,
  sidebarShortDeviceName,
  sidebarHostHueClassName,
  assignSidebarHostHues,
  canPromoteThread,
  buildSidebarSubagentIndex,
  canStopSidebarDelegatedChild,
  isSidebarDelegatedChildThread,
  isSidebarSubagentChildThread,
  withSidebarChildRequest,
  sidebarDelegatedChildState,
  filterSidebarV2VisibleThreads,
  selectSidebarMarkReadTargets,
  resolveAdjacentThreadId,
  resolveSidebarThreadSection,
  resolveSidebarViewIsProjects,
  resolveSidebarPriorityRank,
  resolveSidebarWokeAtForRow,
  countVisibleSidebarPriorityThreads,
  isSidebarPriorityMember,
  holdSidebarPriorityRank,
  resolveSidebarThreadPresentation,
  sortPriorityThreadsForSidebar,
  isSidebarThreadWorking,
  sortInboxThreadsByReturn,
  isSidebarThreadWoke,
  resolveSidebarThreadDragMode,
  shouldCancelSidebarThreadDrag,
} from "./Sidebar.logic";
import { threadSearchMatchKey } from "@goat/client-runtime/state/thread-search";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  NodeId,
  RuntimeRequestId,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type Thread,
} from "../types";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../test-fixtures";
import { DraftId } from "../composerDraftStore";
import { excludeGlobalAgentThreads } from "../globalAgentRoute";
import { effectiveSnoozed } from "@goat/client-runtime/state/thread-settled";
import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import {
  completeSidebarRouteReveal,
  pendingSidebarRouteReveal,
  resolveSidebarRouteReveal,
} from "./sidebar/routeReveal";

const localEnvironmentId = EnvironmentId.make("environment-local");

describe("deleteSelectedThreadEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }, { threadKey: "three" }] as const;
  const success = AsyncResult.success(undefined);
  const failure = AsyncResult.failure(Cause.fail(new Error("Delete failed")));
  const interrupted = AsyncResult.failure(Cause.interrupt());

  it("waits for each delete and excludes only earlier successes from worktree checks", async () => {
    let resolveDelete!: (result: typeof success) => void;
    const pendingDelete = new Promise<typeof success>((resolve) => {
      resolveDelete = resolve;
    });
    const worktreeChecks: { threadKey: string; deletedThreadKeys: string[] }[] = [];
    const deletion = deleteSelectedThreadEntries({
      entries,
      delete: async ({ threadKey }, deletedThreadKeys) => {
        worktreeChecks.push({ threadKey, deletedThreadKeys: [...deletedThreadKeys] });
        return threadKey === "one" ? pendingDelete : success;
      },
    });

    expect(worktreeChecks).toEqual([{ threadKey: "one", deletedThreadKeys: [] }]);
    resolveDelete(success);
    const outcome = await deletion;

    expect(worktreeChecks).toEqual([
      { threadKey: "one", deletedThreadKeys: [] },
      { threadKey: "two", deletedThreadKeys: ["one"] },
      { threadKey: "three", deletedThreadKeys: ["one", "two"] },
    ]);
    expect(outcome).toEqual({
      deletedThreadKeys: new Set(["one", "two", "three"]),
      firstFailure: null,
    });
  });

  it("continues after ordinary failures and keeps the first failure", async () => {
    const laterFailure = AsyncResult.failure(Cause.fail(new Error("Later failure")));
    const deletedKeysAtLastEntry: string[][] = [];
    const outcome = await deleteSelectedThreadEntries({
      entries: [...entries, { threadKey: "four" }],
      delete: async ({ threadKey }, deletedThreadKeys) => {
        if (threadKey === "one") return failure;
        if (threadKey === "three") return laterFailure;
        if (threadKey === "four") deletedKeysAtLastEntry.push([...deletedThreadKeys]);
        return success;
      },
    });

    expect(deletedKeysAtLastEntry).toEqual([["two"]]);
    expect(outcome).toEqual({
      deletedThreadKeys: new Set(["two", "four"]),
      firstFailure: failure,
    });
  });

  it.each([
    { firstResult: success, deletedThreadKeys: new Set(["one"]), firstFailure: null },
    { firstResult: failure, deletedThreadKeys: new Set<string>(), firstFailure: failure },
  ])("stops on interruption and preserves earlier results %#", async (testCase) => {
    const attemptedThreadKeys: string[] = [];
    const outcome = await deleteSelectedThreadEntries({
      entries,
      delete: async ({ threadKey }) => {
        attemptedThreadKeys.push(threadKey);
        return threadKey === "one" ? testCase.firstResult : interrupted;
      },
    });

    expect(attemptedThreadKeys).toEqual(["one", "two"]);
    expect(outcome).toEqual({
      deletedThreadKeys: testCase.deletedThreadKeys,
      firstFailure: testCase.firstFailure,
    });
  });
});

describe("archiveSelectedThreadEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }, { threadKey: "three" }] as const;
  const success = { _tag: "Success" } as const;
  const failure = { _tag: "Failure" } as const;

  it("stops at a mutation failure and retains prior successes", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      if (entry.threadKey === "two") return failure;
      onArchived();
      return success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one"],
      mutationFailure: failure,
      followupFailures: [],
    });
  });

  it("continues after a post-archive failure", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      onArchived();
      return entry.threadKey === "two" ? failure : success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      mutationFailure: null,
      followupFailures: [failure],
    });
  });
});

describe("sidebar thread lineage helpers", () => {
  it("maps an open subagent to its nearest visible ancestor's sidebar row", () => {
    const environmentId = EnvironmentId.make("environment-row");
    const otherEnvironmentId = EnvironmentId.make("environment-other");
    const subagentOf = (id: string, parentId: ThreadId, environment = environmentId) =>
      makeThreadFixture({
        id: ThreadId.make(id),
        environmentId: environment,
        lineage: {
          rootThreadId: parentId,
          parentThreadId: parentId,
          relationshipToParent: "subagent",
        },
      });
    const root = makeThreadFixture({ id: ThreadId.make("thread-root"), environmentId });
    const fork = makeThreadFixture({
      id: ThreadId.make("thread-fork"),
      environmentId,
      lineage: {
        rootThreadId: root.id,
        parentThreadId: root.id,
        relationshipToParent: "fork",
      },
    });
    const child = subagentOf("thread-child", root.id);
    const grandchild = subagentOf("thread-grandchild", child.id);
    const forkChild = subagentOf("thread-fork-child", fork.id);
    const orphan = subagentOf("thread-orphan", ThreadId.make("thread-missing"));
    const elsewhere = subagentOf("thread-elsewhere", root.id, otherEnvironmentId);
    const threads = [root, fork, child, grandchild, forkChild, orphan, elsewhere];

    expect(resolveSidebarRowThreadId(child.id, environmentId, threads)).toBe(root.id);
    expect(resolveSidebarRowThreadId(grandchild.id, environmentId, threads)).toBe(root.id);
    expect(resolveSidebarRowThreadId(forkChild.id, environmentId, threads)).toBe(fork.id);
    expect(resolveSidebarRowThreadId(elsewhere.id, otherEnvironmentId, threads)).toBe(elsewhere.id);
    expect(resolveSidebarRowThreadId(orphan.id, environmentId, threads)).toBe(orphan.id);
    const loopA = subagentOf("thread-loop-a", ThreadId.make("thread-loop-b"));
    const loopB = subagentOf("thread-loop-b", loopA.id);
    expect(resolveSidebarRowThreadId(loopA.id, environmentId, [loopA, loopB])).toBe(loopA.id);
  });
});

function makeLatestRun(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): NonNullable<Thread["latestRun"]> {
  return {
    runId: "turn-1" as never,
    status: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt:
      overrides?.startedAt !== undefined ? overrides.startedAt : "2026-03-09T10:00:00.000Z",
    completedAt:
      overrides?.completedAt !== undefined ? overrides.completedAt : "2026-03-09T10:05:00.000Z",
  };
}

describe("orderItemsByPreferredIds", () => {
  it("resolves legacy preference aliases without materializing project state", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: "physical-a", cwd: "/work/a" },
        { id: "physical-b", cwd: "/work/b" },
        { id: "physical-c", cwd: "/work/c" },
      ],
      preferredIds: ["legacy:/work/c", "legacy:/work/a"],
      getId: (project) => project.id,
      getPreferenceIds: (project) => [project.id, `legacy:${project.cwd}`],
    });

    expect(ordered.map((project) => project.id)).toEqual([
      "physical-c",
      "physical-a",
      "physical-b",
    ]);
  });
});

describe("resolveSidebarThreadStatus", () => {
  const runtime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };

  const idle = { hasPendingApprovals: false, hasPendingUserInput: false, runtime: null };

  it("prioritizes awaiting input over a running runtime, below approval", () => {
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        hasPendingUserInput: true,
        runtime,
        blockedOnThreadWait: true,
      }),
    ).toBe("input");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        blockedOnThreadWait: true,
        runtime,
      }),
    ).toBe("approval");
  });

  it("shows a waiting guest message as a Request, below the agent's own requests", () => {
    expect(resolveSidebarThreadStatus({ ...idle, pendingGuestMessageCount: 1, runtime })).toBe(
      "request",
    );
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        hasPendingUserInput: true,
        pendingGuestMessageCount: 1,
      }),
    ).toBe("input");
  });

  it("keeps usage-limit stops Limited and visible until the thread recovers", () => {
    const limited = {
      ...runtime,
      status: "failed" as const,
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit" as const,
    };
    expect(resolveSidebarThreadStatus({ ...idle, runtime: limited })).toBe("limited");
    expect(
      resolveSidebarThreadStatus({ ...idle, runtime: { ...limited, status: "running" } }),
    ).toBe("working");
    expect(
      resolveSidebarThreadStatus({ ...idle, runtime: { ...limited, status: "completed" } }),
    ).toBe("ready");
    expect(resolveSidebarV2TopStatus({ status: "limited", isUnread: false, isWoke: false })).toBe(
      "limited",
    );
    expect(
      shouldRecedeSidebarThread({
        status: "limited",
        isUnread: false,
        isWoke: false,
        isActive: false,
        isSelected: false,
      }),
    ).toBe(false);
  });

  it("reports failed only while the latest run failed", () => {
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "failed" as const, lastError: "boom" },
      }),
    ).toBe("failed");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "completed" as const, lastError: "persisted" },
      }),
    ).toBe("ready");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "idle" as const, lastError: "persisted" },
      }),
    ).toBe("waiting");
  });
});

describe("searchSidebarThreads", () => {
  const searchThread = (id: string, title: string, latestUserMessageAt: string) => ({
    environmentId: localEnvironmentId,
    id: ThreadId.make(id),
    title,
    branch: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: latestUserMessageAt,
    latestUserMessageAt,
    opens: null,
  });
  const threads = [
    searchThread("thread-1", "Fix workspace search", "2026-10-20T00:00:00.000Z"),
    searchThread("thread-2", "Review providers", "2026-10-22T00:00:00.000Z"),
    searchThread("thread-3", "WORKTREE cleanup", "2026-09-01T00:00:00.000Z"),
    searchThread("thread-4", "Homework notes", "2026-10-22T00:00:00.000Z"),
  ];
  const now = Date.parse("2026-10-23T00:00:00.000Z");
  const contentKeys = (...ids: ReadonlyArray<string>) =>
    new Set(
      ids.map((id) =>
        threadSearchMatchKey({ environmentId: localEnvironmentId, threadId: ThreadId.make(id) }),
      ),
    );

  it("ranks word matches by recent use, then lists message matches once", () => {
    expect(searchSidebarThreads(threads, "work", contentKeys("thread-1", "thread-2"), now)).toEqual(
      {
        titleMatches: [threads[0], threads[2], threads[3]],
        contentMatches: [threads[1]],
      },
    );
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "plan" as const,
    latestRun: null,
    lastVisitedAt: undefined,
    runtime: {
      status: "running" as const,
      providerName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      activeRunId: "turn-1" as never,
      lastError: null,
      updatedAt: "2026-03-09T10:00:00.000Z",
    },
  };

  it("shows an active thread wait without a pulse and resumes Working when it ends", () => {
    const blocked = { ...baseThread, blockedOnThreadWait: true };
    expect(resolveSidebarThreadStatus(blocked)).toBe("waiting");
    expect(resolveThreadStatusPill({ thread: blocked })).toMatchObject({
      label: "Waiting",
      pulse: false,
    });

    const resumed = { ...blocked, blockedOnThreadWait: false };
    expect(resolveSidebarThreadStatus(resumed)).toBe("working");
    expect(resolveThreadStatusPill({ thread: resumed })).toMatchObject({
      label: "Working",
      pulse: true,
    });
  });

  it("shows waiting for an idle thread with pending background tasks", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          pendingBackgroundTasks: [
            { taskId: "bg-1", description: "Watch build", kind: "monitor", awaited: true },
          ],
          runtime: {
            ...baseThread.runtime,
            status: "idle",
            activeRunId: null,
          },
        },
      }),
    ).toMatchObject({
      label: "Waiting",
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          latestRun: makeLatestRun(),
          runtime: {
            ...baseThread.runtime,
            status: "completed",
            activeRunId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("does not manufacture completed state without a client visit marker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestRun: makeLatestRun(),
          runtime: {
            ...baseThread.runtime,
            status: "completed",
            activeRunId: null,
          },
        },
      }),
    ).toBeNull();
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestRun: makeLatestRun(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          runtime: {
            ...baseThread.runtime,
            status: "completed",
            activeRunId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("shows failed, not completed, when the unseen run failed", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestRun: { ...makeLatestRun(), status: "failed" },
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          runtime: {
            ...baseThread.runtime,
            status: "failed",
            activeRunId: null,
            lastError: "Provider turn failed.",
          },
        },
      }),
    ).toMatchObject({ label: "Failed", pulse: false });
  });

  it("shows failed, not plan ready, when a plan run proposed a plan and then failed", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          latestRun: { ...makeLatestRun(), status: "failed" },
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          runtime: { ...baseThread.runtime, status: "failed", activeRunId: null },
        },
      }),
    ).toMatchObject({ label: "Failed" });
  });

  it("drops the failed pill once the failure has been seen", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestRun: { ...makeLatestRun(), status: "failed" },
          lastVisitedAt: "2026-03-09T10:06:00.000Z",
          runtime: { ...baseThread.runtime, status: "failed", activeRunId: null },
        },
      }),
    ).toBeNull();
  });
});

describe("resolveProjectStatusIndicator", () => {
  it("ranks waiting below active work and above plan-ready", () => {
    const waiting = {
      label: "Waiting" as const,
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    };

    expect(
      resolveProjectStatusIndicator([
        waiting,
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        },
      ]),
    ).toMatchObject({ label: "Working" });
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
        waiting,
      ]),
    ).toMatchObject({ label: "Waiting" });
  });
});

function makeProject(overrides: Partial<Project> = {}): Project {
  const { defaultModelSelection, ...rest } = overrides;
  return {
    id: ProjectId.make("project-1"),
    environmentId: localEnvironmentId,
    title: "Project",
    workspaceRoot: "/tmp/project",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...defaultModelSelection,
    },
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    ...rest,
  };
}

function makeThread(overrides: ThreadFixtureOverrides = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

describe("getFallbackThreadIdAfterDelete", () => {
  it("skips other threads being deleted in the same action", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-newest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-next"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:07:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      deletedThreadIds: new Set([ThreadId.make("thread-active"), ThreadId.make("thread-newest")]),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-next"));
  });
});

describe("sortProjectsForSidebar", () => {
  it("sorts projects by the most recent user message across their threads", () => {
    const projects = [
      makeProject({ id: ProjectId.make("project-1"), title: "Older project" }),
      makeProject({ id: ProjectId.make("project-2"), title: "Newer project" }),
    ];
    const threads = [
      makeThread({
        projectId: ProjectId.make("project-1"),
        updatedAt: "2026-03-09T10:20:00.000Z",
        messages: [
          {
            id: "message-1" as never,
            role: "user",
            text: "older project user message",
            runId: null,
            createdAt: "2026-03-09T10:01:00.000Z",
            updatedAt: "2026-03-09T10:01:00.000Z",
            streaming: false,
          },
        ],
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        projectId: ProjectId.make("project-2"),
        updatedAt: "2026-03-09T10:05:00.000Z",
        messages: [
          {
            id: "message-2" as never,
            role: "user",
            text: "newer project user message",
            runId: null,
            createdAt: "2026-03-09T10:05:00.000Z",
            updatedAt: "2026-03-09T10:05:00.000Z",
            streaming: false,
          },
        ],
      }),
    ];

    const sorted = sortProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });
});

describe("sortScopedProjectsForSidebar", () => {
  it("keeps identical project ids in different environments separate", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const sharedProjectId = ProjectId.make("shared-project");
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: sharedProjectId,
        title: "Local project",
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: sharedProjectId,
        title: "Remote project",
      }),
    ];
    const threads = [
      makeThread({
        environmentId: localEnvironmentId,
        projectId: sharedProjectId,
        updatedAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        environmentId: remoteEnvironmentId,
        projectId: sharedProjectId,
        updatedAt: "2026-03-09T10:10:00.000Z",
      }),
    ];

    const sorted = sortScopedProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.title)).toEqual(["Remote project", "Local project"]);
  });

  it("does not use archived threads as project activity", () => {
    const projects = [
      makeProject({
        id: ProjectId.make("project-visible"),
        title: "Visible project",
        updatedAt: "2026-03-09T10:01:00.000Z",
      }),
      makeProject({
        id: ProjectId.make("project-archived"),
        title: "Archived-only project",
        updatedAt: "2026-03-09T10:00:00.000Z",
      }),
    ];
    const threads = [
      makeThread({
        id: ThreadId.make("thread-visible"),
        projectId: ProjectId.make("project-visible"),
        updatedAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-archived"),
        projectId: ProjectId.make("project-archived"),
        updatedAt: "2026-03-09T10:10:00.000Z",
        archivedAt: "2026-03-09T10:11:00.000Z",
      }),
    ];

    const sorted = sortScopedProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.title)).toEqual([
      "Visible project",
      "Archived-only project",
    ]);
  });
});

describe("sortSidebarV2ProjectGroups", () => {
  it("does not let a hidden subagent thread reorder projects", () => {
    const olderProjectId = ProjectId.make("project-older");
    const newerProjectId = ProjectId.make("project-newer");
    const olderRootThreadId = ThreadId.make("thread-older-root");
    const projects = [
      {
        ...makeProject({ id: olderProjectId, title: "A older project" }),
        projectKey: "logical-older",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: olderProjectId }],
      },
      {
        ...makeProject({ id: newerProjectId, title: "Z newer project" }),
        projectKey: "logical-newer",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: newerProjectId }],
      },
    ];
    const threads = [
      makeThread({
        id: olderRootThreadId,
        projectId: olderProjectId,
        updatedAt: "2026-03-09T10:01:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-newer-root"),
        projectId: newerProjectId,
        updatedAt: "2026-03-09T10:05:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-hidden-subagent"),
        projectId: olderProjectId,
        updatedAt: "2026-03-09T10:10:00.000Z",
        lineage: {
          rootThreadId: olderRootThreadId,
          parentThreadId: olderRootThreadId,
          relationshipToParent: "subagent",
        },
      }),
    ];

    expect(
      sortSidebarV2ProjectGroups(projects, threads, "updated_at").map(
        (project) => project.projectKey,
      ),
    ).toEqual(["logical-newer", "logical-older"]);
  });
});

describe("pinOrderKeyBetween", () => {
  it("stays strictly ordered under repeated top insertion", () => {
    let head: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const key: string = pinOrderKeyBetween(null, head)!;
      expect(key).not.toBeNull();
      if (head !== null) expect(key < head).toBe(true);
      keys.push(key);
      head = key;
    }
    expect(new Set(keys).size).toBe(100);
  });

  it("stays strictly ordered under repeated middle insertion", () => {
    let low = pinOrderKeyBetween(null, null)!;
    let high = pinOrderKeyBetween(low, null)!;
    for (let i = 0; i < 100; i += 1) {
      const key: string = pinOrderKeyBetween(low, high)!;
      expect(low < key && key < high).toBe(true);
      if (i % 2 === 0) low = key;
      else high = key;
    }
  });

  it("returns null for corrupt or out-of-order bounds instead of throwing", () => {
    expect(pinOrderKeyBetween("z", "a")).toBeNull();
    expect(pinOrderKeyBetween("A!", null)).toBeNull();
    expect(pinOrderKeyBetween(null, "ma")).toBeNull();
    expect(pinOrderKeyBetween("m", "m")).toBeNull();
  });
});

describe("sortPinnedThreadsForSidebar", () => {
  const pinnable = (input: { id: string; createdAt: string; pinOrderKey?: string | null }) => ({
    id: input.id,
    createdAt: input.createdAt,
    pinOrderKey: input.pinOrderKey ?? null,
  });

  it("sorts keyed threads by key ahead of keyless threads in creation order", () => {
    const sorted = sortPinnedThreadsForSidebar([
      pinnable({ id: "keyless-old", createdAt: "2026-03-09T08:00:00.000Z" }),
      pinnable({ id: "second", createdAt: "2026-03-09T09:00:00.000Z", pinOrderKey: "t" }),
      pinnable({ id: "keyless-new", createdAt: "2026-03-09T12:00:00.000Z" }),
      pinnable({ id: "first", createdAt: "2026-03-09T07:00:00.000Z", pinOrderKey: "g" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual([
      "first",
      "second",
      "keyless-new",
      "keyless-old",
    ]);
  });

  it("breaks equal keys by id so raced writes render identically everywhere", () => {
    const sorted = sortPinnedThreadsForSidebar([
      pinnable({ id: "b", createdAt: "2026-03-09T10:00:00.000Z", pinOrderKey: "m" }),
      pinnable({ id: "a", createdAt: "2026-03-09T11:00:00.000Z", pinOrderKey: "m" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b"]);
  });
});

describe("resolveSidebarSweepKeys", () => {
  const ordered = ["a", "b", "c", "d", "blocked"];
  const canSettle = (key: string) => key !== "blocked";

  it("leaves out rows that cannot settle and rows that left the list", () => {
    expect(resolveSidebarSweepKeys(ordered, "c", "blocked", canSettle)).toEqual(["c", "d"]);
    expect(resolveSidebarSweepKeys(ordered, "gone", "a", canSettle)).toEqual([]);
  });
});

describe("navigation after parking a thread", () => {
  it.each([
    ["settle", "settled", null, "thread", true],
    ["settle", "active", null, "thread", false],
    ["settle", "settled", null, "other-thread", false],
    ["snooze", null, "2099-01-01T00:00:00.000Z", "thread", true],
    ["snooze", null, null, "thread", false],
    ["snooze", null, "2026-09-12T09:00:00.000Z", "thread", false],
    ["snooze", null, "2099-01-01T00:00:00.000Z", "thread", false, true],
    ["snooze", null, "2099-01-01T00:00:00.000Z", "other-thread", false],
  ] as const)(
    "%s with state %s / %s on %s navigates: %s",
    (
      action,
      settledOverride,
      snoozedUntil,
      currentThreadKey,
      expected,
      hasPendingApprovals: boolean = false,
    ) => {
      expect(
        shouldNavigateAfterThreadPark({
          threadKey: "thread",
          currentThreadKey,
          action,
          now: "2026-09-12T10:00:00.000Z",
          thread: {
            settledOverride,
            snoozedUntil,
            snoozedAt: null,
            session: null,
            latestTurn: null,
            hasPendingApprovals,
            hasPendingUserInput: false,
          },
        }),
      ).toBe(expected);
    },
  );
});

describe("unseen completion with background work", () => {
  it.each([
    {
      roster: "dev server",
      task: { kind: "command" },
      status: "ready",
      topStatus: "done",
      receded: false,
      pill: "Completed",
    },
    {
      roster: "dev server watchdog",
      task: { kind: "monitor" },
      status: "ready",
      topStatus: "done",
      receded: false,
      pill: "Completed",
    },
    {
      roster: "awaited command",
      task: { kind: "command", awaited: true },
      status: "waiting",
      topStatus: "waiting",
      receded: true,
      pill: "Waiting",
    },
  ] as const)("presents a completed thread with a $roster roster", (expected) => {
    const thread = presentThreadShell(localEnvironmentId, {
      ...makeThreadFixture().source,
      latestRunId: RunId.make("run-background-completion"),
      status: "completed",
      latestRunCompletedAt: DateTime.makeUnsafe("2026-06-20T01:00:00.000Z"),
      lastVisitedAt: DateTime.makeUnsafe("2026-06-20T00:59:00.000Z"),
      pendingBackgroundTasks: [{ taskId: "background-work", ...expected.task }],
    });
    const status = resolveSidebarThreadStatus(thread);
    const isUnread = hasUnseenCompletion(thread);

    expect(isUnread).toBe(true);
    expect(status).toBe(expected.status);
    expect(resolveSidebarV2TopStatus({ status, isUnread, isWoke: false })).toBe(expected.topStatus);
    expect(
      shouldRecedeSidebarThread({
        status,
        isUnread,
        isWoke: false,
        isActive: false,
        isSelected: false,
      }),
    ).toBe(expected.receded);
    expect(resolveThreadStatusPill({ thread })).toMatchObject({ label: expected.pill });
  });
});

describe("Working shelf (beta)", () => {
  const runtime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };
  const backgroundTask = {
    taskId: "bg-1",
    description: "Watch build",
    kind: "monitor" as const,
    awaited: true as const,
  };
  const idle = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    latestRun: makeLatestRun(),
    runtime: null,
  };
  const waiting = {
    ...idle,
    runtime: { ...runtime, status: "idle" as const },
    pendingBackgroundTasks: [backgroundTask],
  };

  it("folds away running threads and threads waiting on background work only", () => {
    expect(isSidebarThreadWorking({ ...idle, runtime })).toBe(true);
    expect(isSidebarThreadWorking(waiting)).toBe(true);
    expect(isSidebarThreadWorking(idle)).toBe(false);
    expect(isSidebarThreadWorking({ ...idle, runtime, hasPendingApprovals: true })).toBe(false);
    expect(isSidebarThreadWorking({ ...idle, runtime, hasPendingUserInput: true })).toBe(false);
    expect(
      isSidebarThreadWorking({
        ...waiting,
        runtime: { ...runtime, status: "failed" as const, lastError: "boom" },
      }),
    ).toBe(false);
  });

  it("keeps a ready plan in the inbox while background work runs", () => {
    expect(
      isSidebarThreadWorking({
        ...waiting,
        interactionMode: "plan",
        hasActionableProposedPlan: true,
      }),
    ).toBe(false);
  });

  describe("sortInboxThreadsByReturn", () => {
    const thread = (
      id: string,
      input: { createdAt: string; completedAt?: string | null; unsettledAt?: string },
    ) => ({
      id: ThreadId.make(id),
      environmentId: localEnvironmentId,
      createdAt: input.createdAt,
      unsettledAt: input.unsettledAt ?? null,
      latestRun:
        input.completedAt === undefined
          ? null
          : { ...makeLatestRun({ completedAt: input.completedAt }), requestedAt: input.createdAt },
    });

    it("puts the thread that finished last on top, whatever its age", () => {
      const sorted = sortInboxThreadsByReturn([
        thread("new", { createdAt: "2026-03-09T11:00:00.000Z" }),
        thread("old-finished-now", {
          createdAt: "2026-03-01T09:00:00.000Z",
          completedAt: "2026-03-09T12:00:00.000Z",
        }),
        thread("reopened", {
          createdAt: "2026-03-02T09:00:00.000Z",
          unsettledAt: "2026-03-09T11:30:00.000Z",
        }),
      ]);
      expect(sorted.map((entry) => entry.id)).toEqual(["old-finished-now", "reopened", "new"]);
    });

    it("counts a return the server does not stamp, like an approval request", () => {
      const waiting = thread("asks-approval", {
        createdAt: "2026-03-09T09:00:00.000Z",
        completedAt: null,
      });
      const finished = thread("finished", {
        createdAt: "2026-03-09T09:30:00.000Z",
        completedAt: "2026-03-09T11:00:00.000Z",
      });
      expect(sortInboxThreadsByReturn([finished, waiting]).map((entry) => entry.id)).toEqual([
        "finished",
        "asks-approval",
      ]);
      expect(
        sortInboxThreadsByReturn([finished, waiting], (entry) =>
          entry === waiting ? Date.parse("2026-03-09T11:05:00.000Z") : undefined,
        ).map((entry) => entry.id),
      ).toEqual(["asks-approval", "finished"]);
    });
  });

  describe("dragging", () => {
    const marker = (name: SidebarListMarker): SidebarListItem => ({ kind: "marker", marker: name });
    const row = (key: string, section: SidebarSection): SidebarListItem => ({
      kind: "thread",
      key,
      section,
    });
    const items: readonly SidebarListItem[] = [
      marker("pinned-header"),
      row("p1", "pinned"),
      marker("pinned-divider"),
      row("a1", "active"),
      row("a2", "active"),
      marker("working-header"),
      row("w1", "working"),
      marker("settled-header"),
      row("s1", "settled"),
    ];

    it("never drops into the Working shelf, and keeps it out of the inbox order", () => {
      expect(resolveSidebarDropTarget(items, "a1", "w1")).toBeNull();
      expect(resolveSidebarDropTarget(items, "p1", "a2")).toEqual({
        section: "active",
        pinnedOrder: [],
        activeOrder: ["a1", "a2", "p1"],
      });
      expect(resolveSidebarDropVerb("active", "working")).toBeNull();
    });

    it.each([
      ["pinned", "p1"],
      ["active", "a2"],
      ["settled", "s1"],
    ] as const)(
      "does not move a Working thread into %s when its reference drag ends in the sidebar",
      (section, overKey) => {
        const target = resolveSidebarDropTarget(items, "w1", overKey);
        expect(target?.section).toBe(section);
        expect(
          planSidebarThreadDrop({
            activeKey: "w1",
            activeSection: "working",
            target: target!,
            pinnedOrder: ["p1"],
            pinnedKeysById: new Map([["p1", "m"]]),
            activeOrder: ["a1", "a2"],
            activeKeysById: new Map([
              ["a1", "f"],
              ["a2", "t"],
            ]),
            activeTimeOrdered: true,
          }),
        ).toEqual({ kind: "none" });
      },
    );

    it("arranges the rows it can write when another row's server cannot store an order", () => {
      const plan = planSidebarThreadDrop({
        activeKey: "a2",
        activeSection: "active",
        target: {
          section: "active",
          pinnedOrder: [],
          activeOrder: ["offline", "a2", "a1"],
        },
        pinnedOrder: [],
        pinnedKeysById: new Map(),
        activeOrder: ["offline", "a1", "a2"],
        activeKeysById: new Map([
          ["offline", null],
          ["a1", null],
          ["a2", null],
        ]),
        activeReorderableKeys: new Set(["a1", "a2"]),
      });
      expect(plan.kind).toBe("move-active");
      if (plan.kind !== "move-active") return;
      expect(plan.assignments.map(({ id }) => id)).toEqual(["a2", "a1"]);
      const [a2, a1] = plan.assignments.map(({ orderKey }) => orderKey);
      expect(a2! < a1!).toBe(true);

      const above = planSidebarThreadDrop({
        activeKey: "a2",
        activeSection: "active",
        target: { section: "active", pinnedOrder: [], activeOrder: ["a2", "offline"] },
        pinnedOrder: [],
        pinnedKeysById: new Map(),
        activeOrder: ["offline", "a2"],
        activeKeysById: new Map([
          ["offline", "m"],
          ["a2", "t"],
        ]),
        activeReorderableKeys: new Set(["a2"]),
      });
      expect(above.kind === "move-active" && above.assignments[0]!.orderKey < "m").toBe(true);
    });

    it("only changes lifecycle when the inbox is time-ordered", () => {
      const base = {
        pinnedOrder: ["p1"],
        pinnedKeysById: new Map([["p1", "m"]]),
        activeOrder: ["a1", "a2"],
        activeKeysById: new Map([
          ["a1", "f"],
          ["a2", "t"],
        ]),
        activeTimeOrdered: true,
      };
      expect(
        planSidebarThreadDrop({
          ...base,
          activeKey: "a1",
          activeSection: "active",
          target: { section: "active", pinnedOrder: ["p1"], activeOrder: ["a2", "a1"] },
        }),
      ).toEqual({ kind: "none" });
      expect(
        planSidebarThreadDrop({
          ...base,
          activeKey: "p1",
          activeSection: "pinned",
          target: { section: "active", pinnedOrder: [], activeOrder: ["a1", "p1", "a2"] },
        }),
      ).toEqual({
        kind: "move-active",
        order: null,
        assignments: [],
        unpin: true,
        unsettle: false,
        unsnooze: false,
      });
    });
  });
});

describe("sidebar delegated children", () => {
  it("offers promotion only for delegated tasks on servers that understand it", () => {
    const supported = { threadPromotion: true };
    const task = delegatedChild("task", { forkedFrom: { type: "node", nodeId: NodeId.make("n") } });
    expect(canPromoteThread(task, supported)).toBe(true);
    expect(canPromoteThread(task, {})).toBe(false);
    expect(canPromoteThread(task, undefined)).toBe(false);
    const notTasks = [
      delegatedChild("provider", {
        creationSource: "provider",
        forkedFrom: { type: "node", nodeId: NodeId.make("n") },
      }),
      delegatedChild("promoted", {
        lineage: {
          rootThreadId: ThreadId.make("promoted"),
          parentThreadId: null,
          relationshipToParent: null,
        },
        forkedFrom: { type: "node", nodeId: NodeId.make("n") },
      }),
      delegatedChild("deleted", {
        deletedAt: DateTime.makeUnsafe("2026-10-12T03:00:00Z"),
        forkedFrom: { type: "node", nodeId: NodeId.make("n") },
      }),
    ];
    expect(notTasks.map((thread) => canPromoteThread(thread, supported))).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("separates delegated tasks from provider-native subagents and dead or non-subagent threads", () => {
    const live = [
      delegatedChild("local", { status: "running" }),
      delegatedChild("remote", { status: "running" }, EnvironmentId.make("remote")),
    ];
    const native = delegatedChild("native", { creationSource: "provider", status: "running" });
    const excluded = [
      delegatedChild("archived", { archivedAt: DateTime.makeUnsafe("2026-10-12T03:00:00Z") }),
      delegatedChild("deleted", { deletedAt: DateTime.makeUnsafe("2026-10-12T03:00:00Z") }),
      delegatedChild("root", {
        lineage: {
          rootThreadId: ThreadId.make("root"),
          parentThreadId: null,
          relationshipToParent: "subagent",
        },
      }),
      delegatedChild("fork", {
        lineage: {
          rootThreadId: ThreadId.make("parent"),
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "fork",
        },
      }),
    ];
    expect([...live, native].map(isSidebarSubagentChildThread)).toEqual([true, true, true]);
    expect(excluded.map(isSidebarSubagentChildThread)).toEqual(excluded.map(() => false));
    expect([...live, native].map(isSidebarDelegatedChildThread)).toEqual([true, true, false]);
    expect(
      canStopSidebarDelegatedChild(
        delegatedChild("native-running", {
          creationSource: "provider",
          status: "running",
          activeRunId: RunId.make("active"),
        }),
      ),
    ).toBe(false);
  });

  it("classifies queued-only shells separately from older active work with a newer queued run", () => {
    const queued = delegatedChild("queued", {
      status: "queued",
      activityRunStatus: null,
      activeRunId: null,
    });
    const active = delegatedChild("active", {
      status: "queued",
      activityRunStatus: "running",
      activeRunId: RunId.make("older-run"),
    });
    expect(queued.runtime?.status).toBe("queued");
    expect(sidebarDelegatedChildState(queued)).toBe("queued");
    expect(canStopSidebarDelegatedChild(queued)).toBe(false);
    expect(active.runtime?.status).toBe("running");
    expect(sidebarDelegatedChildState(active)).toBe("working");
    expect(canStopSidebarDelegatedChild(active)).toBe(true);
  });

  it.each(["preparing", "starting", "running", "waiting"] as const)(
    "classifies %s from runtime directly",
    (status) => {
      const thread = delegatedChild(status, { status, activeRunId: RunId.make("active") });
      expect(sidebarDelegatedChildState(thread)).toBe("working");
      expect(canStopSidebarDelegatedChild(thread)).toBe(true);
      expect(
        canStopSidebarDelegatedChild(delegatedChild(status, { status, activeRunId: null })),
      ).toBe(false);
    },
  );

  it.each(["command", "user_input"] as const)(
    "shows %s attention before runtime status",
    (kind) => {
      const thread = delegatedChild(kind, {
        status: "waiting",
        activeRunId: RunId.make("active"),
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make(kind),
          kind,
          createdAt: DateTime.makeUnsafe("2026-10-12T01:00:00Z"),
        },
      });
      expect(sidebarDelegatedChildState(thread)).toBe("attention");
      expect(canStopSidebarDelegatedChild(thread)).toBe(true);
    },
  );

  it("keeps idle background work active without offering Stop and treats terminal or missing runtime as finished", () => {
    const background = delegatedChild("background", {
      status: "completed",
      activeRunId: null,
      pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", awaited: true }],
    });
    expect(background.runtime?.status).toBe("idle");
    expect(sidebarDelegatedChildState(background)).toBe("working");
    expect(canStopSidebarDelegatedChild(background)).toBe(false);
    expect(
      canStopSidebarDelegatedChild(
        delegatedChild("background-with-stale-run", {
          status: "completed",
          activeRunId: RunId.make("stale-run"),
          pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", awaited: true }],
        }),
      ),
    ).toBe(false);
    for (const status of [
      "idle",
      "completed",
      "interrupted",
      "failed",
      "cancelled",
      "rolled_back",
    ] as const) {
      expect(sidebarDelegatedChildState(delegatedChild(status, { status }))).toBe("finished");
    }
    expect(sidebarDelegatedChildState(delegatedChild("empty", { latestRunId: null }))).toBe(
      "finished",
    );
  });
});

describe("sidebar subagent index", () => {
  const parent = makeThreadFixture({
    id: ThreadId.make("parent"),
    environmentId: localEnvironmentId,
  });
  const input = (id: string, kind: "user_input" | "command") => ({
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make(id),
      kind,
      createdAt: DateTime.makeUnsafe("2026-10-12T01:04:00Z"),
    },
  });
  const running = delegatedChild("running", { status: "running" });
  const queued = delegatedChild("queued", { status: "queued", activeRunId: null });
  const finished = delegatedChild("finished");
  const native = delegatedChild("native", { creationSource: "provider", status: "running" });
  const remoteEnvironmentId = EnvironmentId.make("juns");
  const remoteParent = { ...parent, environmentId: remoteEnvironmentId };
  const remote = delegatedChild("remote", { status: "running" }, remoteEnvironmentId);
  const all = [parent, running, queued, finished, native, remoteParent, remote];

  it("never gives a subagent its own row, whatever its state, provider or host", () => {
    expect(filterSidebarV2VisibleThreads(all, null)).toEqual([parent, remoteParent]);
  });

  it("keeps side chats out of the thread list; they open beside their parent", () => {
    const sideChat = {
      ...makeThreadFixture({ id: ThreadId.make("side"), environmentId: localEnvironmentId }),
      sideChatOf: parent.id,
    };
    expect(filterSidebarV2VisibleThreads([parent, sideChat], null)).toEqual([parent]);
  });

  it("keeps an open subagent beneath its owner row in every state", () => {
    const owners = buildSidebarSubagentIndex(all).ownerKeyByChildKey;
    for (const child of [running, queued, finished, native]) {
      expect(owners.get(delegatedChildKey(child))).toBe(delegatedParentKey);
    }
    expect(owners.get(delegatedChildKey(remote))).toBe(delegatedChildKey(remoteParent));
    // A matching id on another host is a different thread.
    expect(
      owners.get(scopedThreadKey(scopeThreadRef(remoteEnvironmentId, running.id))),
    ).toBeUndefined();
    expect(owners.get(delegatedParentKey)).toBeUndefined();
    const archived = delegatedChild("archived", {
      archivedAt: DateTime.makeUnsafe("2026-10-12T03:00:00Z"),
    });
    expect(buildSidebarSubagentIndex([parent, archived]).ownerKeyByChildKey.size).toBe(0);
  });

  it("assigns a subagent's own subagents to the first ancestor with a row", () => {
    const grandchild = delegatedChild("grandchild", {
      status: "running",
      lineage: {
        rootThreadId: ThreadId.make("parent"),
        parentThreadId: running.id,
        relationshipToParent: "subagent",
      },
      ...input("grandchild-input", "user_input"),
    });
    const index = buildSidebarSubagentIndex([parent, running, grandchild]);
    expect(index.ownerKeyByChildKey.get(delegatedChildKey(grandchild))).toBe(delegatedParentKey);
    expect(index.attentionByOwnerKey.get(delegatedParentKey)).toBe("input");
  });

  it("carries a delegated task's request on the owner, approvals first, per host", () => {
    const question = delegatedChild("question", input("question", "user_input"));
    const approval = delegatedChild("approval", input("approval", "command"));
    expect(
      buildSidebarSubagentIndex([parent, question]).attentionByOwnerKey.get(delegatedParentKey),
    ).toBe("input");
    for (const order of [
      [question, approval],
      [approval, question],
    ]) {
      expect(
        buildSidebarSubagentIndex([parent, ...order]).attentionByOwnerKey.get(delegatedParentKey),
      ).toBe("approval");
    }
    const remoteQuestion = delegatedChild(
      "remote-question",
      input("remote-question", "user_input"),
      remoteEnvironmentId,
    );
    expect([
      ...buildSidebarSubagentIndex([
        parent,
        remoteParent,
        remoteQuestion,
      ]).attentionByOwnerKey.keys(),
    ]).toEqual([delegatedChildKey(remoteParent)]);
    // Provider-native subagents ask through their parent's own request.
    const nativeQuestion = delegatedChild("native-question", {
      creationSource: "provider",
      ...input("native-question", "user_input"),
    });
    expect(buildSidebarSubagentIndex([parent, nativeQuestion]).attentionByOwnerKey.size).toBe(0);
    expect(buildSidebarSubagentIndex(all).attentionByOwnerKey.size).toBe(0);
  });

  it("keeps an archived parent visible when it carries a child's request", () => {
    const archivedParent = { ...parent, archivedAt: parent.updatedAt };
    const question = delegatedChild("question", input("question", "user_input"));
    const index = buildSidebarSubagentIndex([archivedParent, question]);
    expect(index.attentionByOwnerKey.get(delegatedParentKey)).toBe("input");
    expect(filterSidebarV2VisibleThreads([archivedParent, question], null)).toEqual([]);
    expect(
      filterSidebarV2VisibleThreads(
        [archivedParent, question],
        null,
        new Set(index.attentionByOwnerKey.keys()),
      ),
    ).toEqual([archivedParent]);
    const running = delegatedChild("open-child", { status: "running" });
    expect(
      filterSidebarV2VisibleThreads([archivedParent, running], null, new Set([delegatedParentKey])),
    ).toEqual([archivedParent]);
    expect(
      filterSidebarV2VisibleThreads(
        [{ ...archivedParent, deletedAt: archivedParent.updatedAt }, question],
        null,
        new Set([delegatedParentKey]),
      ),
    ).toEqual([]);
  });

  it("shows the strongest request on the owner without hiding its own", () => {
    const owner = (overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
      delegatedChild("owner", { creationSource: "web", status: "running", ...overrides });
    const status = (thread: ReturnType<typeof owner>, attention?: "approval" | "input") =>
      resolveSidebarThreadStatus(withSidebarChildRequest(thread, attention));
    expect(status(owner())).toBe("working");
    expect(status(owner(), "input")).toBe("input");
    expect(status(owner({ status: "completed" }), "approval")).toBe("approval");
    const asking = owner(input("own-question", "user_input"));
    expect(status(asking, "approval")).toBe("approval");
    expect(status(asking, "input")).toBe("input");
    expect(status(owner(input("own-approval", "command")), "input")).toBe("approval");
  });

  it("finds the owner row past archived or unloaded subagents in between", () => {
    const middle = delegatedChild("middle", {
      archivedAt: DateTime.makeUnsafe("2026-10-12T03:00:00Z"),
    });
    const grandchild = delegatedChild("grandchild", {
      lineage: {
        rootThreadId: ThreadId.make("parent"),
        parentThreadId: middle.id,
        relationshipToParent: "subagent",
      },
      ...input("grandchild-approval", "command"),
    });
    for (const threads of [
      [parent, middle, grandchild],
      [parent, grandchild],
    ]) {
      const index = buildSidebarSubagentIndex(threads);
      expect(index.ownerKeyByChildKey.get(delegatedChildKey(grandchild))).toBe(delegatedParentKey);
      expect(index.ownerKeyByChildKey.has(delegatedChildKey(middle))).toBe(false);
      expect(index.attentionByOwnerKey.get(delegatedParentKey)).toBe("approval");
    }
    // Without a loaded owner there is no row to show it under.
    expect(buildSidebarSubagentIndex([grandchild]).ownerKeyByChildKey.size).toBe(0);
  });

  it("keeps map identity while owners and requests are unchanged", () => {
    const index = buildSidebarSubagentIndex(all);
    const streamed = buildSidebarSubagentIndex(
      all.map((thread) => (thread === running ? { ...running, title: "Renamed" } : thread)),
      index,
    );
    expect(streamed.ownerKeyByChildKey).toBe(index.ownerKeyByChildKey);
    expect(streamed.attentionByOwnerKey).toBe(index.attentionByOwnerKey);
    // Subscribers see the same index object until an owner or request changes.
    expect(streamed).toBe(index);
    const asking = buildSidebarSubagentIndex(
      all.map((thread) =>
        thread === running
          ? { ...running, ...delegatedChild("running", input("q", "user_input")) }
          : thread,
      ),
      streamed,
    );
    expect(asking.ownerKeyByChildKey).toBe(index.ownerKeyByChildKey);
    expect(asking.attentionByOwnerKey).not.toBe(index.attentionByOwnerKey);
  });
});

describe("sidebar view hydration", () => {
  it("holds the sidebar until settings resolve when no view was saved", () => {
    expect(
      resolveSidebarViewIsProjects({ status: "pending", value: true, synchronousValue: null }),
    ).toBeNull();
    expect(
      resolveSidebarViewIsProjects({ status: "retrying", value: false, synchronousValue: null }),
    ).toBeNull();
  });

  it.each([true, false])("paints a synchronous last view of %s before hydration", (value) => {
    expect(
      resolveSidebarViewIsProjects({ status: "pending", value: !value, synchronousValue: value }),
    ).toBe(value);
  });

  it("uses the hydrated choice, and Activity when hydration fails with nothing saved", () => {
    expect(
      resolveSidebarViewIsProjects({ status: "ready", value: false, synchronousValue: true }),
    ).toBe(false);
    expect(
      resolveSidebarViewIsProjects({ status: "failed", value: true, synchronousValue: null }),
    ).toBe(false);
    expect(
      resolveSidebarViewIsProjects({ status: "failed", value: false, synchronousValue: true }),
    ).toBe(true);
  });
});

describe("Activity Priority", () => {
  const before = "2026-03-09T10:04:00.000Z";
  const after = "2026-03-09T10:06:00.000Z";
  const rank = (thread: Thread, hasChildAttention = false, wokeAt: string | null = null) =>
    resolveSidebarPriorityRank({ thread, hasChildAttention, wokeAt });
  const section = (thread: Thread) =>
    resolveSidebarThreadSection({
      snoozed: effectiveSnoozed(thread, { now: "2026-03-09T10:10:00.000Z" }),
      settled: thread.settledOverride === "settled",
      pinned: thread.pinnedAt != null,
      priority: rank(thread) !== null,
    });

  it("keeps snoozed work out of Priority, including pinned settled work", () => {
    const thread = makeThread({
      runtime: delegatedChild("running", { status: "running" }).runtime,
      snoozedAt: before,
      snoozedUntil: "2026-03-09T12:00:00.000Z",
      settledOverride: "settled",
      pinnedAt: before,
    });
    expect(rank(thread)).toBe(1);
    expect(section(thread)).toBe("snoozed");
  });

  it("returns settled unread work to Settled after a visit without changing lifecycle", () => {
    const thread = makeThread({
      settledOverride: "settled",
      settledAt: before,
      latestRun: makeLatestRun(),
      lastVisitedAt: before,
      pinnedAt: before,
    });
    const original = { ...thread };
    expect(section(thread)).toBe("priority");
    expect(rank(thread)).toBe(2);
    expect(thread).toEqual(original);
    expect(section({ ...thread, lastVisitedAt: after })).toBe("settled");
    expect(thread.settledAt).toBe(before);
  });

  it("returns a running pin to its saved position once completed and read", () => {
    const thread = makeThread({
      pinnedAt: before,
      pinOrderKey: "m",
      runtime: delegatedChild("running", { status: "running" }).runtime,
    });
    expect(section(thread)).toBe("priority");
    const read = { ...thread, runtime: null, latestRun: makeLatestRun(), lastVisitedAt: after };
    expect(section(read)).toBe("pinned");
    expect(
      sortPinnedThreadsForSidebar([
        makeThread({ id: ThreadId.make("later-pin"), pinnedAt: before, pinOrderKey: "t" }),
        read,
      ]).map((thread) => thread.id),
    ).toEqual(["thread-1", "later-pin"]);
    expect(thread.pinnedAt).toBe(before);
    expect(thread.pinOrderKey).toBe("m");
  });

  it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
    "ranks %s ahead of running or unread work",
    (field) => {
      const thread = makeThread({
        [field]: true,
        runtime: delegatedChild("running", { status: "running" }).runtime,
        latestRun: makeLatestRun(),
        lastVisitedAt: before,
      });
      expect(rank(thread)).toBe(0);
    },
  );

  it.each(["running", "idle"] as const)("includes %s work without unread completion", (status) => {
    expect(rank(makeThread({ runtime: delegatedChild(status, { status }).runtime }))).toBe(1);
  });

  it("uses server visits authoritatively and falls back to local visits on older servers", () => {
    const thread = makeThread({ latestRun: makeLatestRun(), lastVisitedAt: before });
    const input = { thread, localLastVisitedAt: after, wokeAt: null, hasChildAttention: false };
    expect(resolveSidebarPriorityRank(input)).toBe(2);
    expect(
      resolveSidebarPriorityRank({ ...input, thread: { ...thread, lastVisitedAt: null } }),
    ).toBeNull();
    expect(
      resolveSidebarPriorityRank({ ...input, thread: { ...thread, lastVisitedAt: undefined } }),
    ).toBeNull();
    expect(
      resolveSidebarPriorityRank({
        ...input,
        localLastVisitedAt: before,
        thread: { ...thread, lastVisitedAt: undefined },
      }),
    ).toBe(2);
  });

  it("marks only unread threads in operable environments from a mixed-permission list", () => {
    const readOnlyEnvironment = EnvironmentId.make("read-only");
    const legacyEnvironment = EnvironmentId.make("legacy");
    const writableUnread = makeThread({ latestRun: makeLatestRun(), lastVisitedAt: before });
    const readOnlyUnread = makeThread({
      environmentId: readOnlyEnvironment,
      latestRun: makeLatestRun(),
      lastVisitedAt: before,
    });
    const writableRead = makeThread({
      id: ThreadId.make("already-read"),
      latestRun: makeLatestRun(),
      lastVisitedAt: after,
    });
    const legacyUnread = {
      ...makeThread({ environmentId: legacyEnvironment, latestRun: makeLatestRun() }),
      lastVisitedAt: undefined,
    };
    const threads = [readOnlyUnread, writableUnread, writableRead, legacyUnread];
    const localLastVisitedAtByKey = {
      [delegatedChildKey(writableUnread)]: after,
      [scopedThreadKey(scopeThreadRef(legacyUnread.environmentId, legacyUnread.id))]: before,
    };
    const permitted = new Set([localEnvironmentId, legacyEnvironment]);
    const targets = () =>
      selectSidebarMarkReadTargets({
        threads,
        localLastVisitedAtByKey,
        canOperate: (thread) => permitted.has(thread.environmentId),
      });
    expect(targets()).toEqual([writableUnread, legacyUnread]);
    permitted.clear();
    expect(targets()).toEqual([]);
    permitted.add(readOnlyEnvironment);
    expect(targets()).toEqual([readOnlyUnread]);
    expect(
      selectSidebarMarkReadTargets({
        threads: [writableRead],
        localLastVisitedAtByKey,
        canOperate: () => true,
      }),
    ).toEqual([]);
  });

  it("includes unacknowledged wakes, including settled rows, but not malformed wakes", () => {
    const thread = makeThread({ lastVisitedAt: before, settledOverride: "settled" });
    expect(rank(thread, false, after)).toBe(2);
    expect(rank({ ...thread, lastVisitedAt: after }, false, after)).toBeNull();
    expect(rank(thread, false, "invalid")).toBeNull();
    expect(isSidebarThreadWoke(after, "invalid")).toBe(true);
  });

  it("includes woke-only rows in mark all as read", () => {
    const woke = makeThread({ id: ThreadId.make("woke-only"), lastVisitedAt: before });
    const read = makeThread({ id: ThreadId.make("already-visited"), lastVisitedAt: after });
    const wokeAtByKey = new Map([
      [delegatedChildKey(woke), after],
      [delegatedChildKey(read), after],
    ]);
    expect(
      selectSidebarMarkReadTargets({
        threads: [read, woke],
        localLastVisitedAtByKey: {},
        wokeAtByKey,
        canOperate: () => true,
      }),
    ).toEqual([woke]);
  });

  it("clears a wake when the row is settled and restores it when unsettled", () => {
    const acknowledged = new Set<string>();
    const row = (
      key: string,
      settledOverride: "settled" | null,
      heldSettledOverride: "settled" | null | undefined,
      rawWokeAt: string | null = after,
    ) =>
      resolveSidebarWokeAtForRow({
        key,
        rawWokeAt,
        settledOverride,
        heldSettledOverride,
        acknowledged,
      });
    expect(row("settling", "settled", null)).toBeNull();
    expect(row("settling", "settled", "settled")).toBeNull();
    expect(row("settling", null, "settled")).toBe(after);
    expect(row("already", "settled", "settled")).toBe(after);
    expect(row("gone", "settled", null, null)).toBeNull();
    expect(acknowledged.has("gone")).toBe(false);
  });

  it("lets mark all as read drop a row once it no longer qualifies", () => {
    const holds = new Map([["read", null as null]]);
    expect(
      holdSidebarPriorityRank({
        rank: null,
        key: "read",
        settledOverride: null,
        holds,
        released: true,
      }),
    ).toBeNull();
    expect(
      holdSidebarPriorityRank({
        rank: 2,
        key: "read",
        settledOverride: null,
        holds,
        released: true,
      }),
    ).toBe(2);
  });

  it("counts the threads Priority shows, including wakes and running work", () => {
    const now = "2026-03-09T10:10:00.000Z";
    const unread = makeThread({ latestRun: makeLatestRun(), lastVisitedAt: before });
    const woke = makeThread({
      id: ThreadId.make("woke"),
      snoozedAt: before,
      snoozedUntil: before,
      lastVisitedAt: "2026-03-09T10:00:00.000Z",
    });
    const running = makeThread({
      id: ThreadId.make("running"),
      runtime: delegatedChild("count-running", { status: "running" }).runtime,
    });
    const snoozedRunning = makeThread({
      id: ThreadId.make("snoozed-running"),
      runtime: delegatedChild("count-running", { status: "running" }).runtime,
      snoozedAt: before,
      snoozedUntil: "2026-03-09T12:00:00.000Z",
    });
    const deleted = makeThread({
      id: ThreadId.make("deleted"),
      deletedAt: before,
      hasPendingApprovals: true,
    });
    const idle = makeThread({ id: ThreadId.make("idle"), lastVisitedAt: after });
    expect(
      countVisibleSidebarPriorityThreads({
        threads: [unread, woke, running, snoozedRunning, deleted, idle],
        now,
        localLastVisitedAtByKey: {},
        attentionByOwnerKey: new Map(),
        supportsSnooze: () => true,
        supportsSettlement: () => true,
      }),
    ).toBe(3);
    expect(
      isSidebarPriorityMember({
        thread: snoozedRunning,
        now,
        localLastVisitedAt: undefined,
        hasChildAttention: false,
        supportsSnooze: true,
        supportsSettlement: true,
      }),
    ).toBe(false);
  });

  it("keeps a read Priority row until Activity is shown again, unless its settled state changes", () => {
    const holds = new Map([
      ["read", null],
      ["settled", "settled" as const],
    ]);
    const hold = (key: string, rank: 0 | 1 | 2 | null, settledOverride: "settled" | null) =>
      holdSidebarPriorityRank({ rank, key, settledOverride, holds });
    expect(hold("read", null, null)).toBe(2);
    expect(hold("settled", null, "settled")).toBe(2);
    expect(hold("read", 0, null)).toBe(0);
    expect(hold("read", null, "settled")).toBeNull();
    expect(hold("settled", null, null)).toBeNull();
    expect(hold("never-shown", null, null)).toBeNull();
    expect(
      holdSidebarPriorityRank({ rank: null, key: "read", settledOverride: null, holds: new Map() }),
    ).toBeNull();
  });

  it("lifts the parent for delegated attention while the child stays off the list", () => {
    const parent = makeThread({ id: ThreadId.make("parent"), settledOverride: "settled" });
    const attention = delegatedChild("attention", {
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("input"),
        kind: "user_input",
        createdAt: DateTime.makeUnsafe("2026-10-12T01:04:00Z"),
      },
    });
    const finished = delegatedChild("finished");
    const index = buildSidebarSubagentIndex([parent, attention, finished]);
    expect(filterSidebarV2VisibleThreads([parent, attention, finished], null)).toEqual([parent]);
    expect(rank(parent, index.attentionByOwnerKey.has(delegatedParentKey))).toBe(0);
    const presentation = resolveSidebarThreadPresentation({ settled: true, snoozed: false });
    expect(presentation.action).toBe("unsettle");
  });

  it("keeps global agents, delegated children, archived threads and out-of-scope threads out of candidates", () => {
    const global = makeThread({ id: ThreadId.make("global"), hasPendingApprovals: true });
    const candidate = makeThread({ hasPendingUserInput: true });
    const archived = makeThread({ id: ThreadId.make("archived"), archivedAt: before });
    const otherProject = makeThread({
      id: ThreadId.make("other"),
      projectId: ProjectId.make("other"),
    });
    const visible = excludeGlobalAgentThreads(
      filterSidebarV2VisibleThreads(
        [global, candidate, archived, otherProject, delegatedChild("attention")],
        new Set([`${localEnvironmentId}:project-1`]),
      ),
      {
        environmentId: localEnvironmentId,
        threadId: global.id,
        draftId: DraftId.make("global-draft"),
      },
    );
    expect(visible).toEqual([candidate]);
  });

  it("sorts attention, work and unread by creation time with stable scoped-key ties", () => {
    const thread = (id: string, createdAt: string, overrides: ThreadFixtureOverrides = {}) =>
      makeThread({ id: ThreadId.make(id), createdAt, updatedAt: createdAt, ...overrides });
    const attention = thread("attention", before, { hasPendingApprovals: true });
    const childAttention = thread("child-attention", after);
    const working = thread("working", after, {
      runtime: delegatedChild("running", { status: "running" }).runtime,
    });
    const unread = thread("unread", after, { latestRun: makeLatestRun(), lastVisitedAt: before });
    const tie = thread("z-attention", before, { hasPendingUserInput: true });
    const threads = [tie, unread, working, attention, childAttention];
    const ranks = new Map(
      threads.map((thread) => [
        delegatedChildKey(thread),
        rank(thread, thread === childAttention)!,
      ]),
    );
    const ordered = sortPriorityThreadsForSidebar(threads, ranks);
    expect(ordered.map((thread) => thread.id)).toEqual([
      "child-attention",
      "attention",
      "z-attention",
      "working",
      "unread",
    ]);
    expect(sortPriorityThreadsForSidebar(threads.toReversed(), ranks)).toEqual(ordered);
    const streamed = threads.map((candidate) =>
      candidate === attention ? { ...candidate, updatedAt: "2999-01-01T00:00:00.000Z" } : candidate,
    );
    expect(sortPriorityThreadsForSidebar(streamed, ranks).map((thread) => thread.id)).toEqual(
      ordered.map((thread) => thread.id),
    );
    const search = searchSidebarThreads(ordered, "Thread", undefined, Date.parse(after));
    expect(search.titleMatches).toEqual([childAttention, working, unread, attention, tie]);
    expect(
      resolveAdjacentThreadId({
        threadIds: ordered.map((thread) => thread.id),
        currentThreadId: null,
        direction: "next",
      }),
    ).toBe(childAttention.id);
  });

  it("uses lifecycle for row actions independently of pinning or Priority", () => {
    expect(resolveSidebarThreadPresentation({ settled: false, snoozed: false })).toEqual({
      action: "settle",
    });
    expect(resolveSidebarThreadPresentation({ settled: true, snoozed: true })).toEqual({
      action: "unsnooze",
    });
    const rows = [
      { key: "working-pin", settled: false, snoozed: false },
      { key: "settled-unread", settled: true, snoozed: false },
      { key: "awaiting-input", settled: false, snoozed: false },
    ];
    expect(
      resolveSidebarSweepKeys(
        rows.map((row) => row.key),
        "working-pin",
        "awaiting-input",
        (key) =>
          resolveSidebarThreadPresentation(rows.find((row) => row.key === key)!).action ===
          "settle",
      ),
    ).toEqual(["working-pin", "awaiting-input"]);
  });

  it("cancels a drag when its row disappears or changes visible section", () => {
    const drag = { activeKey: "thread", activeSection: "active" as const };
    expect(shouldCancelSidebarThreadDrag([], drag)).toBe(true);
    for (const section of ["priority", "pinned", "snoozed", "settled"] as const) {
      expect(
        shouldCancelSidebarThreadDrag([{ kind: "thread", key: "thread", section }], drag),
      ).toBe(true);
    }
    expect(
      shouldCancelSidebarThreadDrag([{ kind: "thread", key: "thread", section: "active" }], drag),
    ).toBe(false);
  });

  it("rejects Priority drag sources and targets while preserving normal orders", () => {
    const items: SidebarListItem[] = [
      { kind: "marker", marker: "priority-header" },
      { kind: "thread", key: "priority", section: "priority" },
      { kind: "marker", marker: "pinned-header" },
      { kind: "thread", key: "pin", section: "pinned" },
      { kind: "marker", marker: "pinned-divider" },
      { kind: "thread", key: "active", section: "active" },
      { kind: "marker", marker: "snoozed-header" },
      { kind: "thread", key: "snoozed", section: "snoozed" },
      { kind: "marker", marker: "settled-header" },
    ];
    for (const over of ["priority", "sidebar-marker-priority-header", "snoozed"])
      expect(resolveSidebarDropTarget(items, "active", over)).toBeNull();
    expect(resolveSidebarDropTarget(items, "priority", "active")).toBeNull();
    expect(resolveSidebarDropTarget(items, "active", "sidebar-marker-pinned-header")).toEqual({
      section: "pinned",
      pinnedOrder: ["active", "pin"],
      activeOrder: [],
    });
    expect(
      planSidebarThreadDrop({
        activeKey: "priority",
        activeSection: "priority",
        target: { section: "active", pinnedOrder: [], activeOrder: ["priority", "active"] },
        pinnedOrder: [],
        pinnedKeysById: new Map(),
        activeOrder: ["active"],
        activeKeysById: new Map(),
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("resolveSidebarThreadDragMode", () => {
  const sortable = {
    section: "active",
    reorderable: true,
    renaming: false,
    dropPending: false,
    canOperate: true,
  } as const;

  it("sorts rows the server can order", () => {
    expect(resolveSidebarThreadDragMode(sortable)).toBe("sort");
    expect(resolveSidebarThreadDragMode({ ...sortable, section: "pinned" })).toBe("sort");
    expect(resolveSidebarThreadDragMode({ ...sortable, section: "settled" })).toBe("sort");
  });

  it("keeps context drag for rows that cannot sort", () => {
    // Priority rows never take a manual order, even on a fully capable server.
    expect(resolveSidebarThreadDragMode({ ...sortable, section: "priority" })).toBe("context");
    // Servers without pin ordering (older or remote runtimes).
    expect(resolveSidebarThreadDragMode({ ...sortable, reorderable: false })).toBe("context");
    expect(
      resolveSidebarThreadDragMode({ ...sortable, section: "snoozed", reorderable: false }),
    ).toBe("context");
    // Reading a thread into a composer needs no operate permission on its server.
    expect(resolveSidebarThreadDragMode({ ...sortable, canOperate: false })).toBe("context");
    expect(resolveSidebarThreadDragMode({ ...sortable, dropPending: true })).toBe("context");
  });

  it("blocks every drag during an inline rename", () => {
    expect(resolveSidebarThreadDragMode({ ...sortable, renaming: true })).toBe("none");
    expect(resolveSidebarThreadDragMode({ ...sortable, section: "priority", renaming: true })).toBe(
      "none",
    );
  });
});

describe("Activity sidebar ordering", () => {
  describe("dragging", () => {
    const marker = (name: SidebarListMarker): SidebarListItem => ({ kind: "marker", marker: name });
    const row = (key: string, section: SidebarSection): SidebarListItem => ({
      kind: "thread",
      key,
      section,
    });
    // Priority w1 | Pinned p1 | Active a1 a2 | Settled s1
    const items: readonly SidebarListItem[] = [
      marker("priority-header"),
      row("w1", "priority"),
      marker("pinned-header"),
      row("p1", "pinned"),
      marker("pinned-divider"),
      row("a1", "active"),
      row("a2", "active"),
      marker("settled-header"),
      row("s1", "settled"),
    ];

    it("keeps shelf rows out of the inbox order", () => {
      expect(resolveSidebarDropTarget(items, "a1", "s1")?.section).toBe("settled");
      expect(resolveSidebarDropTarget(items, "p1", "a2")).toEqual({
        section: "active",
        pinnedOrder: [],
        activeOrder: ["a1", "a2", "p1"],
      });
      expect(resolveSidebarDropVerb("active", "priority")).toBeNull();
    });

    it.each([
      ["pinned", "p1"],
      ["active", "a2"],
      ["settled", "s1"],
    ] as const)(
      "does not move a Priority thread into %s when its reference drag ends in the sidebar",
      (section, overKey) => {
        const target = resolveSidebarDropTarget(items, "w1", overKey);
        expect(target).toBeNull();
        expect(
          planSidebarThreadDrop({
            activeKey: "w1",
            activeSection: "priority",
            target: { section, pinnedOrder: ["p1"], activeOrder: ["a1", "a2"] },
            pinnedOrder: ["p1"],
            pinnedKeysById: new Map([["p1", "m"]]),
            activeOrder: ["a1", "a2"],
            activeKeysById: new Map([
              ["a1", "f"],
              ["a2", "t"],
            ]),
          }),
        ).toEqual({ kind: "none" });
      },
    );

    it("arranges the rows it can write when another row's server cannot store an order", () => {
      const plan = planSidebarThreadDrop({
        activeKey: "a2",
        activeSection: "active",
        target: {
          section: "active",
          pinnedOrder: [],
          activeOrder: ["offline", "a2", "a1"],
        },
        pinnedOrder: [],
        pinnedKeysById: new Map(),
        activeOrder: ["offline", "a1", "a2"],
        activeKeysById: new Map([
          ["offline", null],
          ["a1", null],
          ["a2", null],
        ]),
        activeReorderableKeys: new Set(["a1", "a2"]),
      });
      expect(plan.kind).toBe("move-active");
      if (plan.kind !== "move-active") return;
      expect(plan.assignments.map(({ id }) => id)).toEqual(["a2", "a1"]);
      const [a2, a1] = plan.assignments.map(({ orderKey }) => orderKey);
      expect(a2! < a1!).toBe(true);

      const above = planSidebarThreadDrop({
        activeKey: "a2",
        activeSection: "active",
        target: { section: "active", pinnedOrder: [], activeOrder: ["a2", "offline"] },
        pinnedOrder: [],
        pinnedKeysById: new Map(),
        activeOrder: ["offline", "a2"],
        activeKeysById: new Map([
          ["offline", "m"],
          ["a2", "t"],
        ]),
        activeReorderableKeys: new Set(["a2"]),
      });
      expect(above.kind === "move-active" && above.assignments[0]!.orderKey < "m").toBe(true);
    });
  });
});

describe("sidebarFolderName", () => {
  it.each([
    ["/Users/jun/projects/goat", "goat"],
    ["C:\\Users\\jun\\goat", "goat"],
    ["/projects/goat///", "goat"],
    ["C:\\projects\\goat\\", "goat"],
    ["projects\\goat/", "goat"],
    ["/", null],
    ["C:\\", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("resolves %s to %s", (path, expected) => {
    expect(sidebarFolderName(path)).toBe(expected);
  });
});

describe("sidebarShortDeviceName", () => {
  it.each([
    ["juns-MacBook-Pro", "juns"],
    ["Jun's MacBook Pro", "Juns"],
    ["Jun’s MacBook Pro", "Juns"],
    [" host.example.com ", "host"],
    ["host_workstation", "host"],
    ["' MacBook", "' MacBook"],
    ["-host", "-host"],
    ["   ", null],
    [null, null],
    [undefined, null],
  ])("shortens %s to %s", (label, expected) => {
    expect(sidebarShortDeviceName(label)).toBe(expected);
  });
});

describe("sidebarHostHueClassName", () => {
  it("assigns a stable hue from the non-blue palette to each environment", () => {
    const palette = [
      "text-orange-500",
      "text-emerald-500",
      "text-violet-500",
      "text-pink-500",
      "text-amber-500",
      "text-teal-500",
      "text-lime-600",
      "text-rose-500",
    ];
    for (const environmentId of ["local", "remote-mac", "epyc-01", "", "서울"]) {
      const hue = sidebarHostHueClassName(environmentId);
      expect(hue).toBe(sidebarHostHueClassName(environmentId));
      expect(palette).toContain(hue);
    }
  });
});

describe("assignSidebarHostHues", () => {
  const environmentIds = [
    "juns-macbook-pro",
    "juns-mac-studio",
    "lidge-ai",
    "epyc-01",
    "headless-1",
    "headless-2",
    "cloud-sandbox",
    "raspberry-pi",
  ];

  it("gives every device its own hue even when their hashed hues collide", () => {
    // Eight ids over eight hues: the hash alone reuses some of them.
    expect(new Set(environmentIds.map(sidebarHostHueClassName)).size).toBeLessThan(8);

    const hues = assignSidebarHostHues(environmentIds);
    expect(new Set(environmentIds.map((environmentId) => hues.get(environmentId))).size).toBe(8);
  });

  it("does not depend on the order devices are listed in", () => {
    expect([...assignSidebarHostHues(environmentIds.toReversed())].toSorted()).toEqual(
      [...assignSidebarHostHues(environmentIds)].toSorted(),
    );
  });
});

function delegatedChild(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
  environmentId = localEnvironmentId,
) {
  return presentThreadShell(environmentId, {
    ...makeThreadFixture().source,
    id: ThreadId.make(id),
    creationSource: "mcp",
    lineage: {
      rootThreadId: ThreadId.make("parent"),
      parentThreadId: ThreadId.make("parent"),
      relationshipToParent: "subagent",
    },
    latestRunId: RunId.make(`run-${id}`),
    status: "completed",
    createdAt: DateTime.makeUnsafe("2026-10-12T01:00:00Z"),
    updatedAt: DateTime.makeUnsafe("2026-10-12T02:00:00Z"),
    ...overrides,
  });
}

const delegatedChildKey = (thread: ReturnType<typeof delegatedChild>) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

const delegatedParentKey = scopedThreadKey(
  scopeThreadRef(localEnvironmentId, ThreadId.make("parent")),
);
describe("pendingSidebarRouteReveal", () => {
  it("keeps a revealed thread settled across a mount that reads no route params", () => {
    const reveal = { observedKey: null, pendingKey: null };
    expect(pendingSidebarRouteReveal(reveal, "env:a1")).toBe("env:a1");
    completeSidebarRouteReveal(reveal);

    // Back from Settings: location commits before the thread match does.
    expect(pendingSidebarRouteReveal(reveal, null)).toBeNull();
    expect(pendingSidebarRouteReveal(reveal, "env:a1")).toBeNull();

    expect(pendingSidebarRouteReveal(reveal, "env:b1")).toBe("env:b1");
  });

  it("keeps a pending reveal through a render without route params", () => {
    const reveal = { observedKey: null, pendingKey: null };
    pendingSidebarRouteReveal(reveal, "env:a1");
    expect(pendingSidebarRouteReveal(reveal, null)).toBeNull();
    expect(pendingSidebarRouteReveal(reveal, "env:a1")).toBe("env:a1");
  });
});

describe("resolveSidebarRouteReveal", () => {
  const scopedProjectKeys = new Set(["environment-test:project-scoped"]);
  const hidden = makeThreadFixture({ projectId: ProjectId.make("project-other") });
  const hiddenKey = "environment-test:thread-test";
  const findThread = (key: string) => (key === hiddenKey ? hidden : undefined);

  it("widens the scope for a newly opened thread the scope hides", () => {
    expect(
      resolveSidebarRouteReveal({
        reveal: { observedKey: "environment-test:other", pendingKey: null },
        routeKey: hiddenKey,
        isSearching: false,
        scopedProjectKeys,
        findThread,
      }),
    ).toEqual({ pendingKey: hiddenKey, widensScope: true });
  });

  it("never widens for a thread whose reveal already completed", () => {
    // A remount's once-per-mount scroll must keep the scope the user chose.
    expect(
      resolveSidebarRouteReveal({
        reveal: { observedKey: hiddenKey, pendingKey: null },
        routeKey: hiddenKey,
        isSearching: false,
        scopedProjectKeys,
        findThread,
      }),
    ).toEqual({ pendingKey: null, widensScope: false });
  });

  it("widens again for a thread reopened before the thread between them listed its row", () => {
    // The user scoped away from the open thread, then went to a thread whose row
    // never mounted, then came back.
    const reveal = { observedKey: hiddenKey, pendingKey: null };
    const resolve = (routeKey: string) =>
      resolveSidebarRouteReveal({
        reveal,
        routeKey,
        isSearching: false,
        scopedProjectKeys,
        findThread,
      });
    resolve("environment-test:unlisted");
    expect(resolve(hiddenKey)).toEqual({ pendingKey: hiddenKey, widensScope: true });
  });

  it("holds a pending reveal without widening while searching", () => {
    expect(
      resolveSidebarRouteReveal({
        reveal: { observedKey: hiddenKey, pendingKey: hiddenKey },
        routeKey: hiddenKey,
        isSearching: true,
        scopedProjectKeys,
        findThread,
      }),
    ).toEqual({ pendingKey: hiddenKey, widensScope: false });
  });
});
