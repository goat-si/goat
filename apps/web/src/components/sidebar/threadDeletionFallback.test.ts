import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../../test-fixtures";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "../../types";
import { getFallbackThreadIdAfterDelete } from "./threadDeletionFallback";

const localEnvironmentId = EnvironmentId.make("environment-local");
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
      now: "2026-03-09T10:10:00.000Z",
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-next"));
  });
  it.each([
    [
      "snoozed",
      { snoozedUntil: "2099-01-01T00:00:00.000Z", snoozedAt: "2026-03-09T10:06:00.000Z" },
    ],
    ["settled", { settledOverride: "settled", settledAt: "2026-03-09T10:06:00.000Z" }],
    [
      "side chat",
      {
        sideChatOf: ThreadId.make("thread-visible"),
        lineage: {
          rootThreadId: ThreadId.make("thread-visible"),
          parentThreadId: ThreadId.make("thread-visible"),
          relationshipToParent: "fork" as const,
        },
      },
    ],
    [
      "subagent",
      {
        lineage: {
          rootThreadId: ThreadId.make("thread-visible"),
          parentThreadId: ThreadId.make("thread-visible"),
          relationshipToParent: "subagent" as const,
        },
      },
    ],
  ] as const)("skips a %s thread the sidebar does not list", (_state, parked) => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-visible"),
          createdAt: "2026-03-09T10:01:00.000Z",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-parked"),
          createdAt: "2026-03-09T10:02:00.000Z",
          updatedAt: "2026-03-09T10:06:00.000Z",
          ...parked,
        }),
        makeThread({
          id: ThreadId.make("thread-active"),
          createdAt: "2026-03-09T10:03:00.000Z",
          updatedAt: "2026-03-09T10:03:00.000Z",
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      sortOrder: "created_at",
      now: "2026-03-09T10:10:00.000Z",
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-visible"));
  });
});

it("falls back to a visible launcher instead of its folded child", () => {
  const parent = makeThread({
    id: ThreadId.make("launcher"),
    createdAt: "2026-03-09T10:01:00.000Z",
  });
  const originalChild = makeThread({
    id: ThreadId.make("child"),
    createdAt: "2026-03-09T10:02:00.000Z",
  });
  const child = {
    ...originalChild,
    source: {
      ...originalChild.source,
      launchedBy: {
        kind: "launch" as const,
        threadId: parent.id,
        environmentId: null,
        environmentLabel: null,
        threadTitle: null,
        via: "thread_launch" as const,
      },
    },
  };
  const active = makeThread({ id: ThreadId.make("active"), createdAt: "2026-03-09T10:03:00.000Z" });
  expect(
    getFallbackThreadIdAfterDelete({
      threads: [parent, child, active],
      deletedThreadId: active.id,
      sortOrder: "created_at",
      now: "2026-03-09T10:10:00.000Z",
    }),
  ).toBe(parent.id);
});

it("keeps an orphan launched thread eligible after its launcher is deleted", () => {
  const parent = makeThread({ id: ThreadId.make("parent") });
  const base = makeThread({ id: ThreadId.make("orphan"), createdAt: "2026-03-09T10:02:00.000Z" });
  const child = {
    ...base,
    source: {
      ...base.source,
      launchedBy: {
        kind: "launch" as const,
        threadId: parent.id,
        environmentId: null,
        environmentLabel: null,
        threadTitle: null,
        via: "thread_launch" as const,
      },
    },
  };
  expect(
    getFallbackThreadIdAfterDelete({
      threads: [parent, child],
      deletedThreadId: parent.id,
      sortOrder: "created_at",
      now: "2026-03-09T10:10:00.000Z",
    }),
  ).toBe(child.id);
});

it("keeps a pinned launched thread eligible as its own row", () => {
  const parent = makeThread({ id: ThreadId.make("parent") });
  const base = makeThread({
    id: ThreadId.make("pinned"),
    createdAt: "2026-03-09T10:02:00.000Z",
    pinnedAt: "2026-03-09T10:00:00.000Z",
  });
  const child = {
    ...base,
    source: {
      ...base.source,
      launchedBy: {
        kind: "launch" as const,
        threadId: parent.id,
        environmentId: null,
        environmentLabel: null,
        threadTitle: null,
        via: "thread_launch" as const,
      },
    },
  };
  const active = makeThread({ id: ThreadId.make("active"), createdAt: "2026-03-09T10:03:00.000Z" });
  expect(
    getFallbackThreadIdAfterDelete({
      threads: [parent, child, active],
      deletedThreadId: active.id,
      sortOrder: "created_at",
      now: "2026-03-09T10:10:00.000Z",
    }),
  ).toBe(child.id);
});

it("can fall back to a task whose launcher is hidden from the sidebar", () => {
  const parent = makeThread({ id: ThreadId.make("hidden-parent") });
  const base = makeThread({ id: ThreadId.make("child"), createdAt: "2026-03-09T10:02:00.000Z" });
  const child = {
    ...base,
    source: {
      ...base.source,
      launchedBy: {
        kind: "launch" as const,
        threadId: parent.id,
        environmentId: null,
        environmentLabel: null,
        threadTitle: null,
        via: "thread_launch" as const,
      },
    },
  };
  const active = makeThread({ id: ThreadId.make("active"), createdAt: "2026-03-09T10:03:00.000Z" });
  const hiddenParentKeys = new Set([`${parent.environmentId}:${parent.id}`]);
  expect(
    getFallbackThreadIdAfterDelete({
      threads: [parent, child, active],
      deletedThreadId: active.id,
      sortOrder: "created_at",
      now: "2026-03-09T10:10:00.000Z",
      hiddenParentKeys,
    }),
  ).toBe(child.id);
});
