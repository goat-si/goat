import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("unused"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

it.effect("a user message dispatched first stays run 1 when its lineage read is slow", () => {
  const threadId = ThreadId.make("thread:dispatch-order");
  // A file database serves projection reads from a reader worker, so the lineage read a user
  // dispatch makes before taking the thread lock can yield. This gate holds it open instead.
  const lineageReadEntered = Deferred.makeUnsafe<void>();
  const lineageReadRelease = Deferred.makeUnsafe<void>();
  let gateArmed = false;
  const layerGatedLineageRead = ProviderReplayHarness.layerWithRegistry(
    { name: "dispatch-order" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    {
      runEffectWorker: false,
      wrapProjectionStore: (store) => ({
        ...store,
        getThread: (id) => {
          if (!gateArmed || id !== threadId) return store.getThread(id);
          gateArmed = false;
          return Deferred.succeed(lineageReadEntered, undefined).pipe(
            Effect.andThen(Deferred.await(lineageReadRelease)),
            Effect.andThen(store.getThread(id)),
          );
        },
      }),
    },
  );
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-dispatch-order"),
      threadId,
      projectId: ProjectId.make("project:dispatch-order"),
      title: "Dispatch order",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const message = (id: string, createdBy: "user" | "agent") =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId,
        messageId: MessageId.make(id),
        text: id,
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy,
        creationSource: createdBy === "user" ? "web" : "server",
      });

    gateArmed = true;
    const user = yield* message("message:user-first", "user").pipe(Effect.forkChild);
    yield* Deferred.await(lineageReadEntered);
    // Agent messages skip the lineage read, so this one would take a free thread lock first.
    const agent = yield* message("message:agent-second", "agent").pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.succeed(lineageReadRelease, undefined);
    yield* Fiber.join(agent);
    yield* Fiber.join(user);

    const { runs } = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(
      runs.toSorted((left, right) => left.ordinal - right.ordinal).map((run) => run.userMessageId),
      [MessageId.make("message:user-first"), MessageId.make("message:agent-second")],
    );
  }).pipe(Effect.provide(layerGatedLineageRead));
});
