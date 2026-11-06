import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../../test-fixtures";
import type { Thread } from "../../types";
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
  ] as const)("skips a %s thread parked on its shelf", (_state, parked) => {
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
