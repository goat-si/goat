import type { OrchestrationV2PlanArtifact } from "@goat/contracts";
import { NodeId, PlanId, RuntimeRequestId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { type SideChatParentSnapshot, sideChatParentContext } from "./SideChatParentContext.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const shell = (
  overrides: Partial<SideChatParentSnapshot["shell"]> = {},
): SideChatParentSnapshot["shell"] => ({
  title: "Nightly: #1111 tarball",
  status: "running",
  latestRunStopRequested: false,
  pendingRuntimeRequest: null,
  goal: null,
  branch: "goat/nightly-1111-context-diet",
  worktreePath: "/work/nightly",
  lastError: null,
  ...overrides,
});
const message = (role: "user" | "assistant" | "system", text: string, streaming = false) => ({
  role,
  text,
  streaming,
  createdAt: at("2026-10-24T07:30:00.000Z"),
});
const todo = (status: OrchestrationV2PlanArtifact["status"]): OrchestrationV2PlanArtifact => ({
  id: PlanId.make(`plan:${status}`),
  threadId: ThreadId.make("thread:parent"),
  runId: null,
  nodeId: NodeId.make("node:1"),
  status,
  kind: "todo_list",
  steps: [
    { id: "1", text: "Publish the tarball", status: "completed" },
    { id: "2", text: "Verify MCP core", status: "running" },
    { id: "3", text: "Report", status: "pending" },
  ],
});

describe("sideChatParentContext", () => {
  it("reports a running parent with its plan, workspace, and the steering sent mid-run", () => {
    const context = sideChatParentContext({
      shell: shell(),
      messages: [
        message("user", "Ship #1111 to nightly"),
        message("assistant", "Publishing the tarball now", true),
        message("user", "계속"),
      ],
      plans: [todo("superseded"), todo("active")],
    });
    expect(context).toContain("Title: Nightly: #1111 tarball");
    expect(context).toContain("Status: running a turn right now");
    expect(context).toContain(
      "Workspace: branch goat/nightly-1111-context-diet, checkout /work/nightly",
    );
    expect(context).toContain(
      "Task list (1/3 done):\n- [x] Publish the tarball\n- [>] Verify MCP core",
    );
    expect(context).toContain("(still writing)] Publishing the tarball now");
    expect(context.indexOf("Ship #1111")).toBeLessThan(context.indexOf("계속"));
    expect(context.endsWith("계속\n</parent_thread>")).toBe(true);
  });

  it("reports an interrupted parent whose goal is paused", () => {
    const context = sideChatParentContext({
      shell: shell({
        status: "interrupted",
        goal: { objective: "Deploy and verify nightly #1111", status: "paused" },
      }),
      messages: [],
      plans: [],
    });
    expect(context).toContain("Status: idle, its latest turn was interrupted by the user");
    expect(context).toContain("Goal (paused): Deploy and verify nightly #1111");
    expect(context).toContain("Recent conversation: none yet.");
  });

  it("reports a parent that has not run a turn and one waiting on an approval", () => {
    expect(
      sideChatParentContext({ shell: shell({ status: "idle" }), messages: [], plans: [] }),
    ).toContain("Status: idle, no turn has run yet");
    expect(
      sideChatParentContext({
        shell: shell({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request:1"),
            kind: "command",
            createdAt: at("2026-10-24T07:31:00.000Z"),
          },
        }),
        messages: [],
        plans: [],
      }),
    ).toContain("Status: waiting for the user to approve a request (command)");
  });

  it("keeps the newest messages within the budget and drops system notes", () => {
    const messages = Array.from({ length: 30 }, (_, index) =>
      message(index % 2 === 0 ? "user" : "assistant", `turn ${index} ${"x".repeat(2_000)}`),
    );
    const context = sideChatParentContext({
      shell: shell(),
      messages: [...messages, message("system", "internal")],
      plans: [],
    });
    expect(context).toContain("turn 29");
    expect(context).not.toContain("turn 17 ");
    expect(context).not.toContain("internal");
    expect(context.length).toBeLessThan(11_000);
  });

  it("says the parent could not be read instead of leaving the agent to guess", () => {
    expect(sideChatParentContext(null)).toContain("could not be read");
  });
});
