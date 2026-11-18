import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  type ModelSelection,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as MemoryDerivedCache from "../memory/MemoryDerivedCache.ts";
import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as LiveModelSelection from "./goat/LiveModelSelection.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const sessionId = "live-effort-session";
const settings = Schema.decodeSync(ClaudeSettings)({});
const sonnet = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};
const withEffort = (selection: ModelSelection, value: string) => ({
  ...selection,
  options: [{ id: "effort", value }],
});

/**
 * Runs one Claude turn on a fake CLI with the live selection reactor started, then the change.
 * Resolves with every live control call once the first one arrives.
 */
const liveChangeDuringTurn = (
  name: string,
  change: (input: {
    readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
    readonly threadId: ThreadId;
  }) => Effect.Effect<unknown, Orchestrator.OrchestratorV2Error>,
) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(name);
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const calls: Array<unknown> = [];
    const called = yield* Deferred.make<void>();
    const record = (call: unknown) =>
      Effect.sync(() => calls.push(call)).pipe(Effect.andThen(Deferred.succeed(called, undefined)));
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: sonnet.instanceId,
      settings,
      environment: {},
      attachmentsDir: cwd,
      fileSystem: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
      random: yield* SecureRandom.SecureRandom,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: {
        allocateSessionId: Effect.succeed(sessionId),
        open: () =>
          Effect.succeed({
            messages: Stream.fromQueue(sdkMessages),
            offer: () => Effect.void,
            setModel: (model) => record({ model }),
            applyFlagSettings: (flags) => record(flags),
            setPermissionMode: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            stopTask: () => Effect.void,
            interrupt: Effect.die("a live selection change must not interrupt the turn"),
            close: Effect.void,
          }),
        forkSession: () => Effect.die("unused"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    return yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* LiveModelSelection.run;
      const threadId = ThreadId.make(`thread:${name}`);
      const running = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make(`project:${name}`),
        title: "Live selection",
        modelSelection: withEffort(sonnet, "high"),
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("first"),
        threadId,
        messageId: MessageId.make("first"),
        text: "Keep working.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      yield* Fiber.join(running);
      assert.deepEqual(calls, []);

      yield* change({ orchestrator, threadId });
      yield* worker.drain();
      yield* Deferred.await(called);
      return calls;
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name },
          ProviderAdapterRegistry.layerSingle(adapter),
          { runEffectWorker: false },
        ),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        MemoryDerivedCache.layer,
        IdAllocator.layer,
        McpProviderSessions.layer,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  );

it.effect("applies an effort change to the running Claude query without waiting for a turn", () =>
  Effect.gen(function* () {
    const calls = yield* liveChangeDuringTurn("claude-live-effort", ({ orchestrator, threadId }) =>
      orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("medium"),
        threadId,
        modelSelection: withEffort(sonnet, "medium"),
      }),
    );
    assert.deepEqual(calls, [{ effortLevel: "medium", fastMode: null, ultracode: null }]);
  }),
);

// Only the steer path may switch models mid-turn, so the model call proves the selection reached it.
it.effect("applies a model change sent with a steer through the effect worker", () =>
  Effect.gen(function* () {
    const calls = yield* liveChangeDuringTurn(
      "claude-steer-selection",
      ({ orchestrator, threadId }) =>
        Effect.gen(function* () {
          const thread = yield* orchestrator.getThreadProjection(threadId);
          const run = thread.runs[0];
          if (run === undefined) return yield* Effect.die("the first turn has no run");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("steer"),
            threadId,
            messageId: MessageId.make("steer"),
            text: "Switch models and keep going.",
            attachments: [],
            modelSelection: withEffort({ ...sonnet, model: "claude-opus-5-5" }, "high"),
            dispatchMode: { type: "steer_active", targetRunId: run.id },
            createdBy: "user",
            creationSource: "web",
          });
        }),
    );
    assert.deepEqual(calls[0], { model: "claude-opus-5-5" });
  }),
);
