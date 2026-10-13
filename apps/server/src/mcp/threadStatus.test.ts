import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2Run, OrchestrationV2ThreadShell } from "@goat/contracts";
import * as DateTime from "effect/DateTime";

import {
  excerpt,
  LAST_MESSAGE_EXCERPT_CHARS,
  statusFromShell,
  threadPhase,
} from "./threadStatus.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const run = (id: string, status: OrchestrationV2Run["status"]) =>
  ({
    id,
    status,
    requestedAt: at("2026-10-13T01:00:00.000Z"),
    startedAt: status === "queued" ? null : at("2026-10-13T01:00:05.000Z"),
    completedAt: status === "completed" ? at("2026-10-13T01:09:00.000Z") : null,
  }) as unknown as OrchestrationV2Run;

const shell = (fields: Partial<OrchestrationV2ThreadShell>) =>
  ({
    id: "thread-1",
    title: "Fix the flake",
    status: "idle",
    activeRunId: null,
    latestRunId: null,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    lastError: null,
    updatedAt: at("2026-10-13T01:10:00.000Z"),
    ...fields,
  }) as unknown as OrchestrationV2ThreadShell;

describe("threadPhase", () => {
  it.each([
    [null, null, "idle"],
    ["preparing", null, "queued"],
    ["queued", null, "queued"],
    ["starting", null, "starting"],
    ["running", null, "running"],
    ["running", "user_input", "waiting_input"],
    ["waiting", "auth_refresh", "waiting_input"],
    ["waiting", "command", "waiting_approval"],
    ["running", "dynamic_tool_call", "running"],
    ["waiting", null, "waiting"],
    ["interrupted", "user_input", "interrupted"],
  ] as const)("%s with %s pending is %s", (status, pending, phase) => {
    expect(threadPhase(status, pending)).toBe(phase);
  });
});

describe("statusFromShell", () => {
  it("describes the active run, the run queued behind it, and the question it waits on", () => {
    const status = statusFromShell(
      shell({
        status: "waiting",
        activeRunId: "run-1" as never,
        latestRunId: "run-2" as never,
        pendingRuntimeRequest: {
          id: "request-1",
          kind: "user_input",
          createdAt: at("2026-10-13T01:05:00.000Z"),
        } as never,
      }),
      [run("run-1", "waiting"), run("run-2", "queued")],
    );
    expect(status).toMatchObject({
      phase: "waiting_input",
      terminal: false,
      run: { runId: "run-1", status: "waiting", startedAt: "2026-10-13T01:00:05.000Z" },
      queuedRunId: "run-2",
      pendingRequest: { requestId: "request-1", kind: "user_input" },
      lastActivityAt: "2026-10-13T01:10:00.000Z",
    });
  });

  it("reports a finished thread as terminal and ignores a stale request", () => {
    const status = statusFromShell(
      shell({
        status: "completed",
        latestRunId: "run-1" as never,
        pendingRuntimeRequest: {
          id: "request-1",
          kind: "command",
          createdAt: at("2026-10-13T01:05:00.000Z"),
        } as never,
        latestVisibleMessage: {
          role: "assistant",
          text: "x".repeat(LAST_MESSAGE_EXCERPT_CHARS + 50),
          updatedAt: at("2026-10-13T01:09:00.000Z"),
        } as never,
      }),
      [run("run-1", "completed")],
    );
    expect(status).toMatchObject({
      phase: "completed",
      terminal: true,
      queuedRunId: null,
      pendingRequest: null,
      run: { completedAt: "2026-10-13T01:09:00.000Z" },
    });
    expect(Array.from(status.lastMessage?.excerpt ?? "")).toHaveLength(LAST_MESSAGE_EXCERPT_CHARS);
  });

  it("is idle before the first run", () => {
    expect(statusFromShell(shell({}), [])).toMatchObject({ phase: "idle", run: null });
  });

  it("keeps a short message whole", () => {
    expect(excerpt("  done  ")).toBe("done");
  });
});
