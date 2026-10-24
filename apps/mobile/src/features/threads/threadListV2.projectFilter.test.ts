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

import { makeRawThreadShell, makeThreadShellFixture } from "../../test-fixtures";
import { buildThreadListV2Items } from "./threadListV2";

const NOW = "2026-06-02T00:00:00.000Z";
const localEnvironmentId = EnvironmentId.make("travel-mac");
const homeEnvironmentId = EnvironmentId.make("home-mac");

const homeThread = (id: string, raw: Partial<OrchestrationV2ThreadShell> = {}) =>
  presentThreadShell(
    homeEnvironmentId,
    makeRawThreadShell({
      id: ThreadId.make(id),
      title: id,
      projectId: ProjectId.make("home-only-project"),
      latestRunId: RunId.make(`run-${id}`),
      status: "completed",
      ...raw,
    }),
  );

describe("thread list project filter", () => {
  it("keeps active work from every machine visible, but not finished history or subagents", () => {
    const threads = [
      makeThreadShellFixture({
        environmentId: localEnvironmentId,
        id: ThreadId.make("in-scope"),
        title: "in-scope",
        projectId: ProjectId.make("project-1"),
      }),
      homeThread("running", { status: "running", activeRunId: RunId.make("run-running") }),
      homeThread("question", {
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("question"),
          kind: "user_input",
          createdAt: DateTime.makeUnsafe(NOW),
        },
      }),
      homeThread("finished"),
      homeThread("subagent", {
        status: "running",
        activeRunId: RunId.make("run-subagent"),
        lineage: {
          rootThreadId: ThreadId.make("running"),
          parentThreadId: ThreadId.make("running"),
          relationshipToParent: "subagent",
        },
      }),
    ];
    const layout = buildThreadListV2Items({
      threads,
      environmentId: null,
      projectRefs: [{ environmentId: localEnvironmentId, projectId: ProjectId.make("project-1") }],
      searchQuery: "",
      now: NOW,
    });
    expect(layout.items.map((item) => item.thread.id).toSorted()).toEqual([
      "in-scope",
      "question",
      "running",
    ]);
  });
});
