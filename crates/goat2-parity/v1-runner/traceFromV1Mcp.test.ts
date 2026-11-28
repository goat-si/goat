// Delegated-completion mapping of traceFromV1Mcp on synthetic v1 stored events. Run in a v1 export
// copy like the runner (run-v1.sh copies this directory), e.g.
// pnpm --dir <v1>/apps/server exec vp test run src/orchestration-v2/testkit/<copy>/traceFromV1Mcp.test.ts
import { describe, expect, it } from "vite-plus/test";

import { traceFromV1Mcp } from "./traceFromV1Mcp.ts";

const P = "thread:p";
const C1 = "thread:c1";
const C2 = "thread:c2";
let sequence = 0;
const ev = (type: string, threadId: string, payload: any) => ({ sequence: ++sequence, event: { type, threadId, payload } });
const task = (id: string, child: string) => ev("subagent.updated", P, { id, childThreadId: child, status: "completed" });
const message = (taskIds: string[]) => ev("message.updated", P, { id: "m:wake", role: "user", text: "wake", delegatedCompletion: { parentRunId: "run:p1", generation: 1, taskIds } });
const run = (status: string) => ev("run.updated", P, { id: "run:p2", status, userMessageId: "m:wake" });
const trace = (stored: any[]) => traceFromV1Mcp({
  scenario: { name: "synthetic", streams: { codex: {} } }, stored, augmented: { entries: [] }, state: { cursor: 0, failure: null },
  threadAliases: new Map([[P, "p1"], [C1, "c1"], [C2, "c2"]]), messageInputs: new Map(), callMessages: new Map(), callRuns: new Map(),
  toolResults: [], replayObserved: [],
});

describe("delegated completion wakes", () => {
  it("maps a single-task completion to the child input and a started wake", () => {
    sequence = 0;
    const t = trace([task("t1", C1), message(["t1"]), run("queued"), run("running"), run("completed")]);
    expect(t.outcome).toEqual({ outcome: "ok" });
    expect(t.events.map((e: any) => [e.kind, e.input ?? e.wake ?? e.run ?? null, e.state ?? e.mode ?? null])).toEqual([
      ["child.started", null, null],
      ["child.reported", null, null],
      ["input.accepted", "c1#1", "queue"],
      ["parent.woken", "w1", "queued"],
      ["run.started", "r1", null],
      ["parent.woken", "w1", "started"],
      ["run.finished", "r1", null],
    ]);
  });

  it("never completes when a queued singleton absorbs a sibling (Orchestrator.ts:11315-11388)", () => {
    sequence = 0;
    const t = trace([task("t1", C1), message(["t1"]), run("queued"), task("t2", C2), message(["t1", "t2"]), run("running"), run("completed")]);
    expect(t.outcome.outcome).toBe("incomplete");
    expect(t.incomplete).toBe(true);
    expect(t.events.some((e: any) => e.kind === "parent.woken")).toBe(false);
  });
});
