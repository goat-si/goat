import { presentThreadShell } from "@goat/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";

const localEnvironmentId = EnvironmentId.make("travel-mac");
const homeEnvironmentId = EnvironmentId.make("home-mac");
const scope = new Set([`${localEnvironmentId}:project-1`]);

// A thread the home machine started for itself: top level, launched by a thread on the same
// machine, in a project this client has no registration for.
const homeThread = (id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  presentThreadShell(homeEnvironmentId, {
    ...makeThreadFixture().source,
    id: ThreadId.make(id),
    projectId: ProjectId.make("home-only-project"),
    createdBy: "agent",
    creationSource: "mcp",
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    launchedBy: {
      kind: "launch",
      threadId: ThreadId.make("home-coordinator"),
      environmentId: null,
      environmentLabel: null,
      threadTitle: "Coordinator",
      via: "thread_launch",
    },
    latestRunId: RunId.make(`run-${id}`),
    status: "completed",
    ...overrides,
  });

const inScope = makeThreadFixture({
  id: ThreadId.make("in-scope"),
  environmentId: localEnvironmentId,
  projectId: ProjectId.make("project-1"),
});
const running = homeThread("running", { status: "running", activeRunId: RunId.make("run-1") });
const approval = homeThread("approval", {
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make("approval"),
    kind: "command",
    createdAt: DateTime.makeUnsafe("2026-10-24T01:00:00Z"),
  },
});
const background = homeThread("background", {
  pendingBackgroundTasks: [{ taskId: "watcher", kind: "monitor", awaited: true }],
});
const finished = homeThread("finished");
const subagent = homeThread("subagent", {
  status: "running",
  activeRunId: RunId.make("run-subagent"),
  launchedBy: undefined,
  lineage: {
    rootThreadId: running.id,
    parentThreadId: running.id,
    relationshipToParent: "subagent",
  },
});
const all = [inScope, running, approval, background, finished, subagent];

describe("Activity under a project filter", () => {
  it("keeps every machine's active top-level work, but not its finished history or subagents", () => {
    expect(filterSidebarV2VisibleThreads(all, scope).map((thread) => thread.id)).toEqual([
      inScope.id,
      running.id,
      approval.id,
      background.id,
    ]);
  });

  it("lists threads of projects this client has not registered once no filter is set", () => {
    expect(filterSidebarV2VisibleThreads(all, null).map((thread) => thread.id)).toEqual([
      inScope.id,
      running.id,
      approval.id,
      background.id,
      finished.id,
    ]);
  });
});
