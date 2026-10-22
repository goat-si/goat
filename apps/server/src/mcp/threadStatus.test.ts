import { describe, expect, it } from "@effect/vitest";
import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  boundedStatus,
  excerpt,
  LAST_ERROR_CHARS,
  LAST_MESSAGE_EXCERPT_CHARS,
  statusFromShell,
  threadPhase,
} from "./threadStatus.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const isJson = Schema.is(Schema.Json);

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

const message = (type: OrchestrationV2TurnItem["type"], text: string, ordinal: number) =>
  ({
    type,
    text,
    ordinal,
    updatedAt: at(`2026-10-13T01:0${ordinal}:30.000Z`),
  }) as unknown as OrchestrationV2TurnItem;

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
      [],
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
      }),
      [run("run-1", "completed")],
      [
        message("user_message", "Fix the flake", 1),
        message("assistant_message", "x".repeat(LAST_MESSAGE_EXCERPT_CHARS + 50), 9),
      ],
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

  it("takes the latest user or assistant message, skipping other items and empty ones", () => {
    const status = statusFromShell(
      shell({ status: "running", activeRunId: "run-1" as never, latestRunId: "run-1" as never }),
      [run("run-1", "running")],
      [
        message("assistant_message", "Looking at the test.", 3),
        message("user_message", "Fix the flake", 1),
        message("reasoning", "Thinking about the test.", 4),
        message("assistant_message", "   ", 5),
      ],
    );
    expect(status.lastMessage).toEqual({
      role: "assistant",
      excerpt: "Looking at the test.",
      at: "2026-10-13T01:03:30.000Z",
    });
  });

  it("cuts a huge last error to a bounded size", () => {
    const status = statusFromShell(
      shell({ status: "failed", latestRunId: "run-1" as never, lastError: "e".repeat(1_048_576) }),
      [run("run-1", "failed")],
      [],
    );
    expect(status.lastError).toHaveLength(LAST_ERROR_CHARS);
    expect(status.lastError?.endsWith("…")).toBe(true);
  });

  it("is idle before the first run", () => {
    const status = statusFromShell(shell({}), [], []);
    expect(status).toMatchObject({ phase: "idle", run: null });
    expect(isJson(status)).toBe(true);
    expect(isJson(boundedStatus({ ...status, cloudTask: undefined }))).toBe(true);
  });

  it("keeps a short message whole", () => {
    expect(excerpt("  done  ")).toBe("done");
  });

  describe("failure", () => {
    const failed = {
      ...run("run-1", "failed"),
      workspacePreparation: { type: "worktree", baseRef: "dev" },
    } as unknown as OrchestrationV2Run;
    const error = (code: string, log?: string) =>
      ({
        type: "error",
        status: "failed",
        runId: "run-1",
        ordinal: 2,
        failure: {
          class: "unknown",
          code,
          retryable: true,
          message: "Workspace preparation failed during provision worktree: timed out.",
          ...(log === undefined ? {} : { log }),
        },
      }) as unknown as OrchestrationV2TurnItem;
    const failedShell = shell({ status: "failed", latestRunId: "run-1" as never });

    it("names a failed workspace preparation with its log, as retryable", () => {
      const status = statusFromShell(
        failedShell,
        [failed],
        [
          error(
            ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
            "Fetching dev from its remote.",
          ),
        ],
      );
      expect(status.failure).toEqual({
        runId: "run-1",
        stage: "workspace_preparation",
        errorClass: "unknown",
        retryable: true,
        message: "Workspace preparation failed during provision worktree: timed out.",
        log: "Fetching dev from its remote.",
        canRetry: true,
      });
    });

    it("names a provider refusal before the first message, which retry cannot repeat", () => {
      const status = statusFromShell(failedShell, [failed], [error("model_not_found")]);
      expect(status.failure).toMatchObject({
        stage: "before_first_message",
        log: null,
        canRetry: false,
      });
    });

    it("leaves a run that failed after its agent answered to its last message", () => {
      const answered = {
        ...message("assistant_message", "Halfway there.", 1),
        runId: "run-1",
      } as unknown as OrchestrationV2TurnItem;
      const status = statusFromShell(failedShell, [failed], [answered, error("provider_crashed")]);
      expect(status.failure).toBeNull();
    });

    it("keeps the end of an oversized log from another host", () => {
      const bounded = boundedStatus({
        lastMessage: null,
        lastError: null,
        cloudTask: undefined,
        failure: {
          runId: "run-1" as never,
          stage: "workspace_preparation",
          errorClass: "unknown",
          retryable: null,
          message: "m".repeat(5_000),
          log: `${"x".repeat(20_000)}\nfatal: the last line`,
          canRetry: false,
        },
      });
      expect(bounded.failure?.message.length).toBeLessThanOrEqual(1_000);
      expect(bounded.failure?.log?.endsWith("fatal: the last line")).toBe(true);
      expect(bounded.failure?.log?.length).toBeLessThanOrEqual(6_000);
    });
  });
});
