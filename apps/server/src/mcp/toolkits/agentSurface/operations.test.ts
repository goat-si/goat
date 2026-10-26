import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import type { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema } from "effect/ai";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { makeOperationTokens } from "../../operations/OperationTokens.ts";
import type { HandoffReader } from "../../operations/handoffReads.ts";
import { ToolDispatch } from "../../ToolDispatch.ts";
import { makeOperations } from "./operations.ts";

const scopeFor = (threadId: string): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "test",
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 0,
  grantedScopes: [],
  reauthorize: () => Effect.void,
  thread: {
    threadId: ThreadId.make(threadId),
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
});
const owner = scopeFor("thread:owner");
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "operations-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "operations-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const answered = (value: unknown) =>
  new McpSchema.CallToolResult({ isError: false, content: [], structuredContent: value });
const refused = (code: string, message: string) =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { code, message },
  });
const ok = (value: unknown): AgentSurfaceResult => ({ status: "ok", value });

type Answer = (
  name: string,
  args: Readonly<Record<string, unknown>>,
) => Effect.Effect<McpSchema.CallToolResult>;

/** The verbs over a dispatch that answers from `answer` and records every call. */
const setup = (answer: Answer, readHandoff?: HandoffReader) =>
  Effect.gen(function* () {
    const calls: Array<{ readonly name: string; readonly args: unknown }> = [];
    const reads = yield* Queue.unbounded<string>();
    const dispatch = ToolDispatch.of({
      call: (name, args) =>
        Effect.suspend(() => {
          calls.push({ name, args });
          return Queue.offer(reads, name).pipe(Effect.andThen(answer(name, args)));
        }),
      served: () => undefined,
    });
    const tokens = yield* makeOperationTokens.pipe(
      Effect.provide(
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(3)),
        }),
      ),
    );
    const noHandoffs: HandoffReader = () => Effect.die("no handoff reads");
    return {
      operations: makeOperations(dispatch, tokens, readHandoff ?? noHandoffs),
      calls,
      reads,
    };
  });
const as =
  (scope: McpInvocationScope) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
const handleOf = (result: AgentSurfaceResult) => {
  const operation = result.meta?.operation;
  if (operation === undefined) throw new Error("expected meta.operation");
  return operation;
};

it.effect("goat_call hands back a handle for accepted work and none for finished work", () =>
  Effect.gen(function* () {
    const { operations } = yield* setup(() => Effect.die("no reads"));
    const delegated = yield* operations.withOperation(
      agentSurfaceRegistry["task.create"],
      ok({ taskId: "task:1", status: "running" }),
    );
    expect(handleOf(delegated)).toMatchObject({
      kind: "task",
      state: "running",
      cancellable: true,
      pollAfterMs: 5_000,
    });
    // A wait-mode delegation that already finished is a plain ok: done.
    const finished = yield* operations.withOperation(
      agentSurfaceRegistry["task.create"],
      ok({ taskId: "task:1", status: "completed" }),
    );
    expect(finished.meta).toBeUndefined();
    const prepared = yield* operations.withOperation(
      agentSurfaceRegistry["ssh.host_prepare"],
      ok({
        kind: "ok",
        status: { host: "box", setup: { operationId: "setup:1", generation: 1, stage: "runtime" } },
      }),
    );
    expect(handleOf(prepared)).toMatchObject({
      kind: "ssh_setup",
      state: "running",
      cancellable: false,
    });
    // Paths that start no long work never carry a handle.
    const read = yield* operations.withOperation(
      agentSurfaceRegistry["task.read"],
      ok({ taskId: "task:1", status: "running" }),
    );
    expect(read.meta).toBeUndefined();
  }).pipe(as(owner)),
);

it.effect("reads a delegated task through task_status and its own checks", () =>
  Effect.gen(function* () {
    let answer: McpSchema.CallToolResult = answered({ taskId: "task:1", status: "queued" });
    const { operations, calls } = yield* setup(() => Effect.succeed(answer));
    const { operationId } = handleOf(
      yield* operations.withOperation(
        agentSurfaceRegistry["task.create"],
        ok({ taskId: "task:1", status: "queued" }),
      ),
    );
    const stateNow = operations
      .read({ operationId })
      .pipe(Effect.map(({ operation }) => operation.state));

    expect(yield* stateNow).toBe("queued");
    expect(calls.at(-1)).toEqual({ name: "task_status", args: { taskId: "task:1" } });
    // A task waiting on a runtime approval is still running: that request is not a handoff.
    answer = answered({ taskId: "task:1", status: "waiting", pendingApproval: { requestId: "r" } });
    expect(yield* stateNow).toBe("running");
    answer = answered({ taskId: "task:1", status: "completed", summary: "done" });
    const done = yield* operations.read({ operationId });
    expect(done.operation).not.toHaveProperty("pollAfterMs");
    expect(done).toMatchObject({ operation: { state: "succeeded" }, result: { status: "ok" } });
    // The handle is valid, but the task's record is gone.
    answer = refused("task_not_found", "No such task.");
    expect(yield* operations.read({ operationId })).toMatchObject({
      operation: { state: "unknown" },
      result: { status: "error", error: { code: "not_found", reason: "task_not_found" } },
    });
  }).pipe(as(owner)),
);

it.effect("reads SSH setup only for the setup it started, and waits on the handoff it needs", () =>
  Effect.gen(function* () {
    let status: Record<string, unknown> = {
      host: "box",
      state: "preparing",
      setup: { operationId: "setup:1", generation: 1, stage: "runtime" },
    };
    let needsHuman = false;
    const { operations } = yield* setup(() =>
      Effect.succeed(
        answered(
          needsHuman
            ? {
                kind: "needs_human",
                handoff: {
                  handoffId: "handoff:1",
                  kind: "terminal",
                  title: "Register the key",
                  state: "pending",
                  expiresAt: null,
                  targetPath: "ssh.host_prepare",
                },
                next: { after: "terminal", call: "goat_ssh_host_prepare" },
                status,
              }
            : { kind: "ok", status },
        ),
      ),
    );
    const { operationId } = handleOf(
      yield* operations.withOperation(
        agentSurfaceRegistry["ssh.host_prepare"],
        ok({ kind: "ok", status }),
      ),
    );
    const stateNow = operations
      .read({ operationId })
      .pipe(Effect.map(({ operation }) => operation));
    expect((yield* stateNow).state).toBe("running");
    needsHuman = true;
    expect(yield* stateNow).toMatchObject({ state: "waiting_human", handoffId: "handoff:1" });
    needsHuman = false;
    status = {
      ...status,
      state: "ready",
      setup: { operationId: "setup:1", generation: 1, stage: "complete" },
    };
    expect((yield* stateNow).state).toBe("succeeded");
    // A newer setup on the same host replaced this one.
    status = { ...status, setup: { operationId: "setup:2", generation: 2, stage: "runtime" } };
    expect((yield* stateNow).state).toBe("unknown");
    expect(yield* Effect.flip(operations.cancel({ operationId }))).toMatchObject({
      reason: "not_cancellable",
    });
  }).pipe(as(owner)),
);

it.effect("waits for the work to finish, reading again every pollAfterMs", () =>
  Effect.gen(function* () {
    let reads = 0;
    const { operations, reads: queue } = yield* setup(() =>
      Effect.sync(() =>
        answered({ taskId: "task:1", status: (reads += 1) < 2 ? "running" : "completed" }),
      ),
    );
    const { operationId } = handleOf(
      yield* operations.withOperation(
        agentSurfaceRegistry["task.create"],
        ok({ taskId: "task:1", status: "running" }),
      ),
    );
    const waiting = yield* Effect.forkChild(operations.wait({ operationId }));
    yield* Queue.take(queue);
    yield* TestClock.adjust("5 seconds");
    const done = yield* Fiber.join(waiting);
    expect(done.operation.state).toBe("succeeded");
    expect(done).not.toHaveProperty("timedOut");
  }).pipe(as(owner)),
);

it.effect("returns at the deadline even while a status read hangs, and cancels nothing", () =>
  Effect.gen(function* () {
    const hang = yield* Deferred.make<McpSchema.CallToolResult>();
    const { operations, calls, reads } = yield* setup(() => Deferred.await(hang));
    const { operationId } = handleOf(
      yield* operations.withOperation(
        agentSurfaceRegistry["task.create"],
        ok({ taskId: "task:1", status: "running" }),
      ),
    );
    const waiting = yield* Effect.forkChild(operations.wait({ operationId, timeoutMs: 1_000 }));
    yield* Queue.take(reads);
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(waiting)).toEqual({
      operation: expect.objectContaining({ state: "unknown" }),
      timedOut: true,
    });
    expect(calls.map(({ name }) => name)).toEqual(["task_status"]);
  }).pipe(as(owner)),
);

it.effect("cancels through task_cancel, then reads the work again", () =>
  Effect.gen(function* () {
    const { operations, calls } = yield* setup((name) =>
      Effect.succeed(
        name === "task_cancel"
          ? answered({ taskId: "task:1", status: "cancel_requested" })
          : answered({ taskId: "task:1", status: "cancelled" }),
      ),
    );
    const { operationId } = handleOf(
      yield* operations.withOperation(
        agentSurfaceRegistry["task.create"],
        ok({ taskId: "task:1", status: "running" }),
      ),
    );
    const cancelled = yield* operations.cancel({ operationId });
    expect(calls.map(({ name, args }) => [name, args])).toEqual([
      ["task_status", { taskId: "task:1" }],
      ["task_cancel", { taskId: "task:1" }],
      ["task_status", { taskId: "task:1" }],
    ]);
    expect(cancelled).toMatchObject({
      operation: { state: "cancelled" },
      result: { status: "ok", value: { status: "cancel_requested" } },
    });
  }).pipe(as(owner)),
);

it.effect("refuses another thread's handle as not found and an aged one as expired", () =>
  Effect.gen(function* () {
    const { operations, calls } = yield* setup(() =>
      Effect.succeed(answered({ taskId: "task:1", status: "running" })),
    );
    const { operationId } = handleOf(
      yield* operations
        .withOperation(
          agentSurfaceRegistry["task.create"],
          ok({ taskId: "task:1", status: "running" }),
        )
        .pipe(as(owner)),
    );
    const stranger = yield* Effect.flip(operations.read({ operationId })).pipe(
      as(scopeFor("thread:stranger")),
    );
    expect(stranger).toMatchObject({ reason: "not_found" });
    yield* TestClock.adjust("31 days");
    const aged = yield* Effect.flip(operations.read({ operationId })).pipe(as(owner));
    expect(aged).toMatchObject({ reason: "expired" });
    expect(calls).toEqual([]);
  }),
);
const pendingSync = {
  handoffId: "handoff:sync",
  kind: "approval",
  title: "Install OpenCode on box?",
  state: "pending",
  expiresAt: null,
  targetPath: "provider.host_sync",
} as const;
const syncState = (done: boolean, phase: string) => ({
  syncId: "sync_1",
  driver: "opencode",
  version: null,
  login: true,
  startedAt: "2026-10-23T00:00:00.000Z",
  done,
  hosts: [{ host: "box", phase, version: null }],
});

it.effect("follows a provider sync from its approval to the sync it started", () =>
  Effect.gen(function* () {
    let handoffState: string = "pending";
    let status: McpSchema.CallToolResult = answered(syncState(false, "installing"));
    const readHandoff: HandoffReader = () =>
      Effect.sync(() =>
        handoffState === "pending"
          ? { status: "needs_human", handoff: pendingSync }
          : ok({ handoff: { ...pendingSync, state: handoffState }, applying: false }),
      );
    const { operations, calls } = yield* setup(
      (name) =>
        Effect.succeed(
          name === "goat_provider_sync_cancel" ? answered(syncState(true, "cancelled")) : status,
        ),
      readHandoff,
    );
    const asked = yield* operations.withOperation(agentSurfaceRegistry["provider.sync"], {
      status: "needs_human",
      handoff: pendingSync,
    });
    const { operationId, ...ref } = handleOf(asked);
    expect(ref).toMatchObject({
      kind: "provider_sync",
      state: "waiting_human",
      handoffId: "handoff:sync",
      cancellable: true,
    });
    // Nothing runs before a person approves, so there is nothing to cancel.
    expect(yield* Effect.flip(operations.cancel({ operationId }))).toMatchObject({
      reason: "not_cancellable",
    });
    expect(calls).toEqual([]);

    handoffState = "completed";
    expect((yield* operations.read({ operationId })).operation.state).toBe("running");
    expect(calls.at(-1)).toEqual({
      name: "goat_provider_sync_status",
      args: { handoffId: "handoff:sync" },
    });
    yield* operations.cancel({ operationId });
    expect(calls.map(({ name }) => name)).toContain("goat_provider_sync_cancel");
    expect(calls.find(({ name }) => name === "goat_provider_sync_cancel")?.args).toEqual({
      syncId: "sync_1",
    });
    status = answered(syncState(true, "signed_in"));
    expect((yield* operations.read({ operationId })).operation.state).toBe("succeeded");
    status = answered(syncState(true, "failed"));
    expect((yield* operations.read({ operationId })).operation.state).toBe("failed");
  }).pipe(as(owner)),
);

it.effect("reads how a sync approval ended, and a sync the store forgot as unknown", () =>
  Effect.gen(function* () {
    let status: McpSchema.CallToolResult = refused("declined", "The person declined this sync.");
    const { operations } = yield* setup(
      () => Effect.succeed(status),
      () => Effect.succeed(ok({ handoff: { ...pendingSync, state: "declined" }, applying: false })),
    );
    const viaApproval = handleOf(
      yield* operations.withOperation(agentSurfaceRegistry["provider.sync"], {
        status: "needs_human",
        handoff: pendingSync,
      }),
    );
    const stateOf = (operationId: string) =>
      operations.read({ operationId }).pipe(Effect.map(({ operation }) => operation.state));
    expect(yield* stateOf(viaApproval.operationId)).toBe("cancelled");
    status = refused("start_failed", "The person approved this sync, but it did not start.");
    expect(yield* stateOf(viaApproval.operationId)).toBe("failed");

    // A person or outside client started it directly: the handle names the sync.
    const direct = handleOf(
      yield* operations.withOperation(
        agentSurfaceRegistry["provider.sync"],
        ok({ kind: "started", sync: syncState(false, "queued") }),
      ),
    );
    expect(direct.state).toBe("running");
    status = refused("not_found", "No such sync. It may have finished more than two hours ago.");
    expect(yield* stateOf(direct.operationId)).toBe("unknown");
  }).pipe(as(owner)),
);
