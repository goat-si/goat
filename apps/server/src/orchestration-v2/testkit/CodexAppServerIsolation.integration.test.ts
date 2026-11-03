import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type CodexAppServerIsolation,
  type OrchestrationV2DomainEvent,
  ProviderDriverKind,
  type ProviderSessionId,
  type ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as CodexAdapter from "../Adapters/CodexAdapterV2.ts";
import * as CodexAdapterTestkit from "../Adapters/CodexAdapterV2.testkit.ts";
import {
  codexReplayPreamble,
  makeCodexReplayTranscript,
  makeCodexReplayTurn,
} from "../Adapters/CodexReplay.testkit.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { CODEX_MODEL_SELECTION, materializeFixtureInput } from "./fixtures/shared.ts";

type Handler = (payload: unknown) => Effect.Effect<void>;

/** One fake app-server process: ending it terminates every thread its client serves. */
interface FakeProcess {
  readonly providerSessionId: ProviderSessionId;
  readonly exit: Deferred.Deferred<never, CodexErrors.CodexAppServerError>;
  readonly handlers: Map<string, Array<Handler>>;
}

const preamble = codexReplayPreamble({
  nativeThreadId: "isolation-native",
  nativeTurnId: "isolation-turn",
  prompt: "start",
});
const handshake = makeCodexReplayTranscript({
  scenario: "codex-app-server-isolation",
  entries: preamble.slice(0, 3),
});
const threadStartEntry = preamble[4];
const threadStartResult =
  threadStartEntry?.type === "emit_inbound"
    ? (threadStartEntry.frame as { result: { thread: Record<string, unknown> } }).result
    : undefined;

const runIsolationScenario = (isolation: CodexAppServerIsolation) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (threadStartResult === undefined) return yield* Effect.die("missing thread/start result");
      const workspace = yield* checkpointWorkspace("codex-app-server-isolation");
      const inputA = yield* materializeFixtureInput({
        scenario: "codex-isolation-a",
        fixtureInput: { steps: [{ type: "message", text: "thread A works" }] },
        driver: ProviderDriverKind.make("codex"),
        modelSelection: CODEX_MODEL_SELECTION,
      });
      const inputB = yield* materializeFixtureInput({
        scenario: "codex-isolation-b",
        fixtureInput: { steps: [{ type: "message", text: "thread B works" }] },
        driver: ProviderDriverKind.make("codex"),
        modelSelection: CODEX_MODEL_SELECTION,
      });
      const threadA = inputA.projectionThreadIds[0];
      const threadB = inputB.projectionThreadIds[0];
      if (threadA === undefined || threadB === undefined)
        return yield* Effect.die("missing test threads");

      const processes: Array<FakeProcess> = [];
      // Native thread id -> the process that started it.
      const owners = new Map<string, FakeProcess>();
      let threadStarts = 0;
      const factory: CodexAdapter.CodexAppServerClientFactoryShape = {
        open: (openInput) =>
          Effect.gen(function* () {
            const process: FakeProcess = {
              providerSessionId: openInput.providerSessionId,
              exit: yield* Deferred.make<never, CodexErrors.CodexAppServerError>(),
              handlers: new Map(),
            };
            processes.push(process);
            const context = yield* Layer.build(CodexReplay.layerReplay(handshake));
            const client = Context.get(context, CodexClient.CodexAppServerClient);
            return {
              ...client,
              terminated: Deferred.await(process.exit).pipe(Effect.flip),
              handleServerNotification: (method, handler) =>
                Effect.sync(() => {
                  const existing = process.handlers.get(method) ?? [];
                  existing.push(handler as Handler);
                  process.handlers.set(method, existing);
                }).pipe(Effect.andThen(client.handleServerNotification(method, handler))),
              request: ((method: string, params: unknown) =>
                Effect.gen(function* () {
                  // A request to an ended process fails the way a closed transport does.
                  if (yield* Deferred.isDone(process.exit))
                    return yield* Deferred.await(process.exit);
                  if (method === "thread/start") {
                    const id = `isolation-native-${++threadStarts}`;
                    owners.set(id, process);
                    return {
                      ...threadStartResult,
                      thread: { ...threadStartResult.thread, id, sessionId: id },
                    };
                  }
                  if (method === "turn/start") {
                    const { threadId } = params as { readonly threadId: string };
                    return {
                      turn: makeCodexReplayTurn({ id: `${threadId}-turn`, status: "inProgress" }),
                    };
                  }
                  return yield* client.request(method as never, params as never);
                })) as typeof client.request,
            } satisfies CodexClient.CodexAppServerClient["Service"];
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: CodexAdapter.CODEX_DRIVER_KIND,
                  providerSessionId: openInput.providerSessionId,
                  cause,
                }),
            ),
          ),
      };

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const firstEvent = (
          threadId: ThreadId,
          predicate: (event: OrchestrationV2DomainEvent) => boolean,
        ) =>
          sink.stream({ threadId, afterSequence: 0 }).pipe(
            Stream.map((stored) => stored.event),
            Stream.filter(predicate),
            Stream.runHead,
            Effect.forkScoped,
          );
        const running = (event: OrchestrationV2DomainEvent) =>
          event.type === "provider-turn.updated" && event.payload.status === "running";
        const ended = (event: OrchestrationV2DomainEvent) =>
          event.type === "run.updated" &&
          (event.payload.status === "completed" || event.payload.status === "failed");

        // Start A, then B, so native thread ids follow thread order.
        const nativeIds = new Map<ThreadId, string>();
        for (const [threadId, input] of [
          [threadA, inputA],
          [threadB, inputB],
        ] as const) {
          const started = yield* firstEvent(threadId, running);
          for (const command of input.commands) yield* orchestrator.dispatch(command);
          yield* Fiber.join(started);
          nativeIds.set(threadId, `isolation-native-${nativeIds.size + 1}`);
        }
        const nativeA = nativeIds.get(threadA);
        const nativeB = nativeIds.get(threadB);
        const processA = nativeA === undefined ? undefined : owners.get(nativeA);
        const processB = nativeB === undefined ? undefined : owners.get(nativeB);
        if (nativeB === undefined || processA === undefined || processB === undefined)
          return yield* Effect.die("missing fake processes");

        const endedA = yield* firstEvent(threadA, ended);
        const endedB = yield* firstEvent(threadB, ended);
        yield* Deferred.fail(
          processA.exit,
          new CodexErrors.CodexAppServerInputStreamEndedError({}),
        );
        yield* Fiber.join(endedA);

        const afterExit = yield* orchestrator.getThreadProjection(threadA);
        assert.equal(afterExit.runs[0]?.status, "failed");
        assert.equal(afterExit.runs[0]?.terminationCause?.kind, "provider_process_exit");

        if (isolation === "shared") {
          // One process serves both threads, so its exit takes B's turn down too.
          yield* Fiber.join(endedB);
          const projectionB = yield* orchestrator.getThreadProjection(threadB);
          assert.equal(projectionB.runs[0]?.status, "failed");
          assert.equal(projectionB.runs[0]?.terminationCause?.kind, "provider_process_exit");
          assert.lengthOf(processes, 1);
          return;
        }

        const beforeCompletion = yield* orchestrator.getThreadProjection(threadB);
        assert.equal(beforeCompletion.runs[0]?.status, "running");
        const turnId = `${nativeB}-turn`;
        for (const handler of processB.handlers.get("item/completed") ?? [])
          yield* handler({
            threadId: nativeB,
            turnId,
            completedAtMs: 1782622442000,
            item: {
              type: "agentMessage",
              id: "isolation-answer",
              text: "thread B finished on its own app-server",
              phase: "final_answer",
            },
          });
        for (const handler of processB.handlers.get("turn/completed") ?? [])
          yield* handler({
            threadId: nativeB,
            turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
          });
        yield* Fiber.join(endedB);
        const projectionB = yield* orchestrator.getThreadProjection(threadB);
        assert.equal(projectionB.runs[0]?.status, "completed");
        assert.isTrue(
          projectionB.turnItems.some(
            (item) =>
              item.type === "assistant_message" &&
              item.text === "thread B finished on its own app-server",
          ),
        );
        assert.deepEqual(
          processes.map((process) => process.providerSessionId),
          [processA.providerSessionId, processB.providerSessionId],
        );
        assert.notEqual(processA.providerSessionId, processB.providerSessionId);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "codex-app-server-isolation", runtimePolicyOverride: { cwd: workspace } },
            CodexAdapterTestkit.layerWithClientFactory({
              scenario: "codex-app-server-isolation",
              clientFactory: factory,
            }),
            { codexAppServerIsolation: isolation },
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

it.effect("one Codex app-server ending leaves another thread's turn running", () =>
  runIsolationScenario("thread"),
);
it.effect("a shared Codex app-server ending fails every thread it serves", () =>
  runIsolationScenario("shared"),
);
