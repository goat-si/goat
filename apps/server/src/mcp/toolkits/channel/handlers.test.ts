import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ChannelLedger from "../../../channels/ChannelLedger.ts";
import * as ChannelGateway from "../../../channels/ChannelGateway.ts";
import * as ChannelReceptionService from "../../../channels/ChannelReceptionService.ts";
import * as ChannelRemoteWorkers from "../../../channels/ChannelRemoteWorkers.ts";
import * as ChannelRuntime from "../../../channels/ChannelRuntime.ts";
import { commitTransition } from "../../../channels/channelTaskWrites.ts";
import {
  environmentId,
  makeHarness,
  setupBot,
  goatInput,
  rpcContext,
  onlyTask,
} from "../../../channels/testkit/ChannelHarness.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ChannelHandlers from "./handlers.ts";
import { ChannelToolkit } from "./tools.ts";

it.effect.each(["ingest", "read"] as const)("MCP %s follows home ownership", (operation) => {
  const harness = makeHarness();
  const other = EnvironmentId.make("environment:other-home");
  const scope = Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId,
    capabilities: new Set(["orchestration"] as const),
    issuedAt: 0,
    requestNamespace: "home-tools",
    thread: undefined,
    client: { sessionId: "home-tools", label: "Agent", access: "full-access" },
  });
  return Effect.gen(function* () {
    const toolkit = yield* ChannelToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(ChannelHandlers.layer)),
    );
    const original = yield* toolkit
      .handle("channel_ingest", { text: "hello", clientRequestId: "before-move" })
      .pipe(Stream.unwrap, Stream.runCollect);
    const receipt = original.at(-1)!.result;
    assert.isTrue("inputId" in receipt, JSON.stringify(receipt));
    if (!("inputId" in receipt)) return;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      goatBotHome: { environmentId: other, claimedAt: 1, claimId: "home" },
    });
    const ledger = yield* ChannelLedger.ChannelLedger;
    const pending = yield* ledger.listPendingInputs(100);
    if (operation === "ingest") {
      const result = yield* toolkit
        .handle("channel_ingest", { text: "hello", clientRequestId: "after-move" })
        .pipe(Stream.unwrap, Stream.runCollect);
      const failure = result.at(-1)!.result;
      assert.isTrue("code" in failure);
      if ("code" in failure) {
        assert.strictEqual(failure.code, "not_home");
        assert.include(failure.message, other);
      }
      assert.deepStrictEqual(yield* ledger.listPendingInputs(100), pending);
    } else {
      const read = yield* toolkit
        .handle("channel_input_get", { inputId: receipt.inputId })
        .pipe(Stream.unwrap, Stream.runCollect);
      const snapshot = read.at(-1)!.result;
      assert.isTrue("inputId" in snapshot);
      if ("inputId" in snapshot) assert.strictEqual(snapshot.inputId, receipt.inputId);
    }
  }).pipe(Effect.provide(Layer.merge(scope, harness.layer)));
});

it.effect.each(["owner", "another-owner"] as const)(
  "read-only export filters %s terminal events",
  (caller) => {
    const harness = makeHarness();
    const scope = Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: caller === "owner" ? environmentId : EnvironmentId.make("environment:other"),
      capabilities: new Set(["orchestration"] as const),
      issuedAt: 0,
      requestNamespace: "export-tools",
      thread: undefined,
      client: { sessionId: "export-tools", label: "Reader", access: "read-only" },
    });
    return Effect.gen(function* () {
      yield* setupBot;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* ledger.claimOwnership({ token: "export-owner", now, staleBefore: now });
      const input = yield* gateway.ingest(
        goatInput("do: export old work", "export-old"),
        rpcContext,
      );
      yield* reception.receive(input.inputId, "export-owner");
      const task = yield* onlyTask;
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        {
          type: "task.cancelled",
          payload: { reason: "No longer needed" },
        },
        { owner: "export-owner" },
      );
      const toolkit = yield* ChannelToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(ChannelHandlers.layer)),
      );
      const result = yield* toolkit
        .handle("channel_task_export", {
          from: now,
          to: "9999-12-31T23:59:59.999Z",
          limit: 1,
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      const page = result.at(-1)!.result;
      assert.isTrue("jsonl" in page);
      if (!("jsonl" in page)) return;
      if (caller === "owner") {
        assert.include(page.jsonl, task.taskId);
        assert.include(page.jsonl, '"brief":null');
        assert.include(page.jsonl, '"terminalState":"cancelled"');
      } else {
        assert.strictEqual(page.jsonl, "");
      }
    }).pipe(Effect.provide(Layer.merge(scope, harness.layer)));
  },
);

it.effect.each([
  "missing_scope",
  "read_scope",
  "other_owner",
  "success",
  "refused",
  "thread_full_access",
  "thread_approval_required",
] as const)("task move handles %s without hiding service refusals", (scenario) => {
  const harness = makeHarness();
  const threadRuntimeMode =
    scenario === "thread_full_access"
      ? ("full-access" as const)
      : scenario === "thread_approval_required"
        ? ("approval-required" as const)
        : undefined;
  const callerThreads =
    threadRuntimeMode === undefined
      ? Layer.empty
      : Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed(liveThreadShell(threadId, { runtimeMode: threadRuntimeMode })),
        });
  const calls: Array<Parameters<ChannelRemoteWorkers.ChannelRemoteWorkers["Service"]["move"]>[0]> =
    [];
  const message = "There is no saved copy of this work yet.";
  const movedAt = "2026-10-12T00:00:00.000Z";
  const remoteWorkers = Layer.mock(ChannelRemoteWorkers.ChannelRemoteWorkers)({
    move: (input) => {
      calls.push(input);
      return scenario === "refused"
        ? Effect.fail(
            new ChannelRemoteWorkers.ChannelTaskMoveError({ reason: "no_replica", message }),
          )
        : Effect.succeed({
            taskId: input.taskId,
            generation: 2,
            host: input.host,
            fromHost: "mac-studio",
            replicaCapturedAt: movedAt,
          });
    },
  });
  const scope = Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId:
      scenario === "other_owner" ? EnvironmentId.make("environment:other") : environmentId,
    capabilities: new Set(["orchestration"] as const),
    issuedAt: 0,
    requestNamespace: "move-tools",
    thread:
      threadRuntimeMode === undefined
        ? undefined
        : {
            threadId: ThreadId.make("thread:move-caller"),
            providerSessionId: "provider:move-caller",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
    client:
      threadRuntimeMode === undefined
        ? { sessionId: "move-tools", label: "Agent", access: "full-access" }
        : undefined,
    ...(scenario === "missing_scope"
      ? {}
      : {
          grantedScopes:
            scenario === "read_scope"
              ? ["orchestration:read" as const]
              : ["orchestration:operate" as const],
        }),
  });
  return Effect.gen(function* () {
    yield* setupBot;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    yield* gateway.ingest(goatInput("do: task to move", "move-source"), rpcContext);
    yield* runtime.drain;
    const task = yield* onlyTask;
    const result = yield* Effect.gen(function* () {
      const toolkit = yield* ChannelToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(ChannelHandlers.layer)),
      );
      const response = yield* toolkit
        .handle("channel_task_move", { taskId: task.taskId, host: "mini" })
        .pipe(Stream.unwrap, Stream.runCollect);
      return response.at(-1)!.result;
    }).pipe(Effect.provide(Layer.mergeAll(scope, remoteWorkers, callerThreads)));
    if (scenario === "missing_scope" || scenario === "read_scope" || scenario === "other_owner") {
      assert.strictEqual(calls.length, 0);
      assert.isTrue("code" in result);
      if ("code" in result) {
        assert.strictEqual(
          result.code,
          scenario === "other_owner" ? "task_not_found" : "capability_denied",
        );
      }
      return;
    }
    assert.deepStrictEqual(calls, [
      {
        taskId: task.taskId,
        host: "mini",
        actor: "agent",
        owner: runtime.ownerToken,
        callerCeiling: threadRuntimeMode ?? "full-access",
      },
    ]);
    if (scenario === "refused") {
      assert.isTrue("code" in result);
      if ("code" in result) {
        assert.strictEqual(result.code, "invalid_request");
        assert.strictEqual(result.message, message);
      }
    } else {
      assert.deepStrictEqual(result, {
        taskId: task.taskId,
        generation: 2,
        host: "mini",
        fromHost: "mac-studio",
        replicaCapturedAt: movedAt,
      });
    }
  }).pipe(Effect.provide(harness.layer));
});
