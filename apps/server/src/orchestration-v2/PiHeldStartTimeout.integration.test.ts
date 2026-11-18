import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { PiPromptAcknowledgmentTimeoutError } from "@goat/provider-pi/server";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const selection = { instanceId, model: "test-model" };

const refusingHarness = Effect.fn("refusingHarness")(function* (name: string) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: Effect.fn("refusingHarness.openSession")(function* (input) {
      const now = yield* DateTime.now;
      return {
        instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd,
          model: selection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.fromQueue(events),
        ensureThread: ({ threadId }) =>
          Effect.succeed({
            id: ProviderThreadId.make(`provider-thread:${threadId}`),
            driver,
            providerInstanceId: instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          }),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        // What Pi's adapter fails a start with when Pi never acknowledged an earlier prompt.
        startTurn: () =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver: ProviderDriverKind.make("pi"),
              detail: new PiPromptAcknowledgmentTimeoutError().message,
              cause: new PiPromptAcknowledgmentTimeoutError(),
            }),
          ),
        steerTurn: () => Effect.void,
        interruptTurn: () => Effect.void,
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: () => Effect.die("unused"),
        rollbackThread: () => Effect.die("unused"),
        forkThread: () => Effect.die("unused"),
      };
    }),
  };
  return ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerSingle(adapter),
    { runEffectWorker: false },
  );
});

it.effect(
  "a Pi start refused after its held wait keeps the message, shows the reason and holds the queue",
  () =>
    Effect.gen(function* () {
      const name = "pi-held-start-timeout";
      const layer = yield* refusingHarness(name);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make(`thread:${name}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make(`project:${name}`),
          title: "Held Pi start",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        for (const [id, text, dispatchMode] of [
          ["message:held", "The message Pi never got", { type: "start_immediately" }],
          ["message:queued", "Queued behind it", { type: "queue_after_active" }],
        ] as const) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(id),
            text,
            attachments: [],
            modelSelection: selection,
            dispatchMode,
            createdBy: "user",
            creationSource: "web",
          });
        }
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepInclude(
          projection.messages.map((message) => ({ id: message.id, text: message.text })),
          { id: MessageId.make("message:held"), text: "The message Pi never got" },
        );
        const [failed, queued] = projection.runs;
        assert.equal(failed?.status, "failed");
        assert.deepInclude(
          projection.turnItems.flatMap((item) =>
            item.type === "error" ? [item.failure?.message] : [],
          ),
          new PiPromptAcknowledgmentTimeoutError().message,
        );
        assert.equal(queued?.status, "queued");
        assert.isTrue(queued?.queueHeld);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);
