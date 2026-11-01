import { assert, it } from "@effect/vitest";
import {
  type AuthMcpClientAccess,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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

/** `access` is read on every check, so a test can lower it while a claim waits. */
const homeScope = (
  access: () => AuthMcpClientAccess,
  reauthorize?: () => Effect.Effect<void, EnvironmentAuthorizationError>,
) =>
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId,
    capabilities: new Set(["orchestration"] as const),
    issuedAt: 0,
    requestNamespace: "home-claim",
    thread: undefined,
    client: {
      sessionId: "home-claim",
      label: "Agent",
      get access() {
        return access();
      },
    },
    ...(reauthorize === undefined ? {} : { reauthorize }),
  });
const gone = EnvironmentId.make("environment:gone");
const goneHome = { environmentId: gone, claimedAt: 1_792_398_593_330, claimId: "gone" };
const callHomeTool = (name: "channel_bot_home" | "channel_bot_home_claim") =>
  ChannelToolkit.pipe(
    Effect.provide(McpToolAccess.HandlersLayer.layer(ChannelHandlers.layer)),
    Effect.flatMap((toolkit) => toolkit.handle(name, {}).pipe(Stream.unwrap, Stream.runCollect)),
    Effect.map((result) => result.at(-1)!.result),
  );

it.effect("an agent moves GOAT Bot off a vanished home and the bot takes messages again", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ goatBotHome: goneHome });
    assert.deepStrictEqual(yield* callHomeTool("channel_bot_home"), {
      home: goneHome,
      environmentId,
      isHome: false,
    });
    const claimed = yield* callHomeTool("channel_bot_home_claim");
    assert.deepInclude(claimed, { claimed: true, environmentId });
    assert.isTrue("claimed" in claimed && claimed.home.claimedAt > goneHome.claimedAt);
    assert.strictEqual((yield* settings.getSettings).goatBotHome?.environmentId, environmentId);
    const toolkit = yield* ChannelToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(ChannelHandlers.layer)),
    );
    const receipt = (yield* toolkit
      .handle("channel_ingest", { text: "hello", clientRequestId: "after-claim" })
      .pipe(Stream.unwrap, Stream.runCollect)).at(-1)!.result;
    assert.isTrue("inputId" in receipt, JSON.stringify(receipt));
  }).pipe(
    Effect.provide(
      Layer.merge(
        homeScope(() => "full-access"),
        harness.layer,
      ),
    ),
  );
});

it.effect.each(["read-only", "approval-required", "auto-accept-edits"] as const)(
  "refuses to move GOAT Bot's home for a %s client",
  (access) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ goatBotHome: goneHome });
      const failure = yield* callHomeTool("channel_bot_home_claim");
      assert.isTrue(
        "code" in failure && failure.code === "capability_denied",
        JSON.stringify(failure),
      );
      assert.deepStrictEqual((yield* settings.getSettings).goatBotHome, goneHome);
    }).pipe(
      Effect.provide(
        Layer.merge(
          homeScope(() => access),
          harness.layer,
        ),
      ),
    );
  },
);

it.effect(
  "a credential revoked while the claim waits for the settings lock changes nothing",
  () => {
    const harness = makeHarness();
    let revoked = false;
    let started: Deferred.Deferred<void> | undefined;
    const reauthorize = () =>
      Effect.suspend(() =>
        revoked
          ? Effect.fail(
              new EnvironmentAuthorizationError({
                message: "revoked",
                requiredScope: "settings:write",
              }),
            )
          : Effect.void,
      );
    // The claim's first check reads the client's access; that read marks it as started.
    const access = (): AuthMcpClientAccess => {
      if (started !== undefined) Deferred.doneUnsafe(started, Effect.void);
      return "full-access";
    };
    return Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ goatBotHome: goneHome });
      const locked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* settings
        .updateSettings(
          {},
          Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(locked);
      const begun = yield* Deferred.make<void>();
      started = begun;
      const claim = yield* callHomeTool("channel_bot_home_claim").pipe(Effect.forkChild);
      yield* Deferred.await(begun);
      // Revoked after the claim passed its first check and while the lock is still held.
      revoked = true;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const failure = yield* Fiber.join(claim);
      assert.isTrue(
        "code" in failure && failure.code === "capability_denied",
        JSON.stringify(failure),
      );
      assert.deepStrictEqual((yield* settings.getSettings).goatBotHome, goneHome);
    }).pipe(Effect.provide(Layer.merge(homeScope(access, reauthorize), harness.layer)));
  },
);
