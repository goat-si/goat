import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  NodeId,
  ProviderDriverKind,
  RunAttemptId,
  RunId,
} from "@goat/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import { CodexDetachedAppServerError } from "../../provider/CodexDetachedAppServer.ts";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as Detached from "../../provider/CodexDetachedAppServerLive.ts";
import * as Survivors from "../../provider/CodexSurvivors.ts";
import * as CodexAdapter from "../Adapters/CodexAdapterV2.ts";
import * as CodexAdapterTestkit from "../Adapters/CodexAdapterV2.testkit.ts";
import {
  codexReplayPreamble,
  makeCodexReplayTranscript,
  makeCodexReplayTurn,
} from "../Adapters/CodexReplay.testkit.ts";
import * as EventSink from "../EventSink.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { CODEX_MODEL_SELECTION, materializeFixtureInput } from "./fixtures/shared.ts";

const runRestartScenario = (
  outcome: "completed" | "gone" | "unknown" | "leftovers",
  queued = false,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const workspace = yield* checkpointWorkspace("codex-survivor-restart");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ prefix: "goat-survivor-e2e-" }),
        (dir) => fs.remove(dir, { recursive: true, force: true }).pipe(Effect.orDie),
      );
      const sourceDb = path.join(temp, "before.sqlite");
      const crashDb = path.join(temp, "crash.sqlite");
      const input = yield* materializeFixtureInput({
        scenario: "codex-survivor-e2e",
        fixtureInput: { steps: [{ type: "message", text: "start survivor" }] },
        driver: ProviderDriverKind.make("codex"),
        modelSelection: CODEX_MODEL_SELECTION,
      });
      const threadId = input.projectionThreadIds[0];
      if (threadId === undefined) return yield* Effect.die("missing test thread");
      const bindings = yield* Ref.make<ReadonlyArray<Survivors.CodexSurvivorBinding>>([]);
      const reads = yield* Deferred.make<void>();
      const nextStarted = yield* Deferred.make<void>();
      const earlyStart = yield* Deferred.make<void>();
      let wakeStarts: Effect.Effect<void> = Effect.void;
      const lost = yield* Deferred.make<CodexErrors.CodexAppServerError>();
      let fence = false;
      let nativeStatus: "inProgress" | "completed" = "inProgress";
      let starts = 0;
      let handlers = new Map<string, Array<(payload: unknown) => Effect.Effect<void>>>();
      const nativeThreadId = "survivor-native-thread";
      const nativeTurnId = "survivor-native-turn";
      const entries = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId,
        prompt: "start survivor",
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "survivor-e2e",
        entries: entries.slice(0, 3),
      });
      const threadResponseEntry = entries[4];
      if (threadResponseEntry?.type !== "emit_inbound")
        return yield* Effect.die("missing fake thread response");
      const threadResponse = (threadResponseEntry.frame as { result: unknown }).result;
      const factory: CodexAdapter.CodexAppServerClientFactoryShape = {
        open: (openInput) =>
          Layer.build(CodexReplay.layerReplay(transcript)).pipe(
            Effect.map((context) => Context.get(context, CodexClient.CodexAppServerClient)),
            Effect.map((client): CodexClient.CodexAppServerClient["Service"] => {
              handlers = new Map();
              return {
                ...client,
                terminated: Deferred.await(lost),
                handleServerNotification: (method, handler) =>
                  Effect.sync(() => {
                    const existing = handlers.get(method) ?? [];
                    existing.push(handler as (payload: unknown) => Effect.Effect<void>);
                    handlers.set(method, existing);
                  }).pipe(Effect.andThen(client.handleServerNotification(method, handler))),
                raw: {
                  ...client.raw,
                  request: (method, params) =>
                    method === "thread/resume"
                      ? Effect.succeed({
                          thread: {
                            id: nativeThreadId,
                            updatedAt: 1,
                            status: { type: "active" },
                          },
                        })
                      : client.raw.request(method, params),
                },
                request: ((method: string, params: unknown) =>
                  Effect.gen(function* () {
                    if (method === "thread/start") return threadResponse;
                    if (method === "turn/start") {
                      starts++;
                      if (starts > 1) yield* Deferred.succeed(nextStarted, undefined);
                      if (starts > 1 && nativeStatus !== "completed")
                        yield* Deferred.succeed(earlyStart, undefined);
                      return {
                        turn: makeCodexReplayTurn({
                          id: starts > 1 ? "queued-native-turn" : nativeTurnId,
                          status: "inProgress",
                        }),
                      };
                    }
                    if (method === "thread/turns/list") {
                      yield* Deferred.succeed(reads, undefined);
                      return {
                        data: [makeCodexReplayTurn({ id: nativeTurnId, status: nativeStatus })],
                        nextCursor: null,
                      };
                    }
                    if (method === "thread/items/list")
                      return {
                        data: [
                          {
                            turnId: nativeTurnId,
                            completedAtMs: 1782622442000,
                            item: {
                              type: "agentMessage",
                              id: "survivor-answer",
                              text: "native survivor result",
                              phase: "final_answer",
                            },
                          },
                        ],
                        nextCursor: null,
                      };
                    return yield* client.request(method as never, params as never);
                  })) as typeof client.request,
              };
            }),
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
      const survivorService = Survivors.CodexSurvivors.of({
        list: Ref.get(bindings),
        startBlockedThreads: Ref.get(bindings).pipe(
          Effect.map((items) => items.map((item) => item.threadId)),
        ),
        setStartWake: (wake) =>
          Effect.sync(() => {
            wakeStarts = wake;
          }),
        release: (binding) =>
          Ref.update(bindings, (items) =>
            items.filter((item) => item.threadId !== binding.threadId),
          ).pipe(Effect.andThen(Effect.suspend(() => wakeStarts))),
        classifyRecord: () =>
          Deferred.isDone(lost).pipe(
            Effect.map((ended) =>
              ended
                ? outcome === "leftovers"
                  ? { type: "gone" as const, possibleLeftovers: [1002] }
                  : { type: outcome === "gone" ? ("gone" as const) : ("unverifiable" as const) }
                : { type: "verified" as const, pgid: 1001, members: [] },
            ),
          ),
        replace: (value) => Ref.set(bindings, value),
        get: (instanceId, id) =>
          Ref.get(bindings).pipe(
            Effect.map((all) =>
              all.find((item) => item.instanceId === instanceId && item.threadId === id),
            ),
          ),
        classifyExisting: () => Effect.succeed("survivor" as const),
        getGoalBlocks: () => Effect.succeed([]),
        listGoalBlocksByInstance: () => Effect.succeed([]),
        getStopObligations: () => Effect.succeed([]),
        recordStopObligation: () =>
          Effect.sync(() => {
            fence = true;
          }),
        clearStopObligation: () =>
          Effect.sync(() => {
            fence = false;
          }),
        recordGoalBlock: () => Effect.void,
        clearGoalBlock: () => Effect.void,
        hasGoalBlock: () => Effect.succeed(false),
        ensureAdmission: () =>
          fence
            ? Effect.fail(
                new CodexDetachedAppServerError({
                  detail: "Codex is running work on this thread from before the restart.",
                }),
              )
            : Effect.void,
      });
      const detached = Layer.mock(Detached.CodexDetachedAppServers)({
        socketTransportEnabled: true,
        loadRecords: Effect.succeed([
          {
            version: 1,
            instanceId: CodexAdapter.CODEX_DEFAULT_INSTANCE_ID,
            name: "codex-survivor-record",
            socketPath: "/tmp/fake-codex.sock",
            pgid: 1001,
            bootId: "boot",
            state: "running",
            createdAt: "2026-01-01T00:00:00Z",
            stderrMode: "discard",
          },
        ]),
        preserveForRecovery: () => Effect.void.pipe(Effect.as(undefined)),
      });
      const shared = Layer.merge(
        Layer.succeed(Survivors.CodexSurvivors, survivorService),
        detached,
      );
      const registry = CodexAdapterTestkit.layerWithClientFactory({
        scenario: "survivor-e2e",
        clientFactory: factory,
      });
      const scenario = { name: "survivor-e2e", runtimePolicyOverride: { cwd: workspace } };
      const db = (file: string) =>
        SqlitePersistence.layerFromPath(file).pipe(Layer.provide(NodeServices.layer));
      const sourceDbLayer = db(sourceDb);
      const crashDbLayer = db(crashDb);
      const waitFor = (
        sink: EventSink.EventSinkV2["Service"],
        predicate: (event: import("@goat/contracts").OrchestrationV2DomainEvent) => boolean,
      ) =>
        sink.stream({ threadId, afterSequence: 0 }).pipe(
          Stream.map((stored) => stored.event),
          Stream.filter(predicate),
          Stream.runHead,
        );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const started = yield* waitFor(
            sink,
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          ).pipe(Effect.forkScoped);
          for (const command of input.commands) yield* orchestrator.dispatch(command);
          yield* Fiber.join(started);
          assert.equal(starts, 1);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`VACUUM INTO ${crashDb}`;
        }).pipe(
          Effect.provide(
            Layer.merge(
              ProviderReplayHarness.layerWithRegistry(scenario, registry, {
                databaseLayer: sourceDbLayer,
              }),
              sourceDbLayer,
            ).pipe(Layer.provide(shared)),
          ),
        ),
      );
      if (queued)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* ProjectionStore.ProjectionStoreV2;
            const outbox = yield* EffectOutbox.EffectOutboxV2;
            const projection = yield* store.getThreadProjection(threadId);
            const source = projection.runs[0];
            const attempt = projection.attempts[0];
            const node = projection.nodes.find((value) => value.id === source?.rootNodeId);
            if (!source || !attempt || !node)
              return yield* Effect.die("missing source run fixture");
            const runId = RunId.make("queued-after-survivor");
            const attemptId = RunAttemptId.make("queued-after-survivor-attempt");
            const nodeId = NodeId.make("queued-after-survivor-node");
            const now = yield* DateTime.now;
            yield* store.apply({
              id: EventId.make("queued:run"),
              type: "run.created",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                ...source,
                id: runId,
                ordinal: source.ordinal + 1,
                activeAttemptId: attemptId,
                rootNodeId: nodeId,
                status: "starting",
                startedAt: null,
                completedAt: null,
              },
            });
            yield* store.apply({
              id: EventId.make("queued:attempt"),
              type: "run-attempt.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                ...attempt,
                id: attemptId,
                runId,
                rootNodeId: nodeId,
                providerTurnId: null,
                status: "pending",
                startedAt: null,
                completedAt: null,
              },
            });
            yield* store.apply({
              id: EventId.make("queued:node"),
              type: "node.updated",
              threadId,
              runId,
              nodeId,
              providerInstanceId: source.providerInstanceId,
              occurredAt: now,
              payload: {
                ...node,
                id: nodeId,
                runId,
                rootNodeId: nodeId,
                providerTurnId: null,
                status: "pending",
                startedAt: null,
                completedAt: null,
              },
            });
            yield* outbox.enqueue([
              {
                id: "queued-after-survivor",
                commandId: CommandId.make("queued-after-survivor"),
                threadId,
                request: { type: "provider-turn.start", runId },
              },
            ]);
          }).pipe(
            Effect.provide(
              Layer.merge(ProjectionStore.layer, EffectOutbox.layer).pipe(
                Layer.provide(crashDbLayer),
              ),
            ),
          ),
        );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* Effect.raceFirst(
            Deferred.await(reads),
            Deferred.await(earlyStart).pipe(
              Effect.andThen(Effect.die("turn/start was sent while the survivor turn was running")),
            ),
          );
          if (queued) {
            const outbox = yield* EffectOutbox.EffectOutboxV2;
            const effect = yield* outbox.get("queued-after-survivor");
            assert.equal(effect._tag, "Some");
            if (effect._tag === "Some")
              assert.deepInclude(effect.value, { status: "pending", attemptCount: 0 });
            assert.equal(starts, 1);
          }
          const waiting = yield* waitFor(
            sink,
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.survivingRestart !== undefined,
          );
          assert.equal(waiting._tag, "Some");
          const terminal = yield* waitFor(
            sink,
            (event) =>
              event.type === "run.updated" &&
              event.payload.restartContinuationOfRunId !== undefined &&
              event.payload.status === (outcome === "completed" ? "completed" : "failed"),
          ).pipe(Effect.forkScoped);
          if (outcome === "completed") {
            nativeStatus = "completed";
            for (const handler of handlers.get("item/completed") ?? [])
              yield* handler({
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                completedAtMs: 1782622442000,
                item: {
                  type: "agentMessage",
                  id: "survivor-answer",
                  text: "native survivor result",
                  phase: "final_answer",
                },
              });
            for (const handler of handlers.get("turn/completed") ?? [])
              yield* handler({
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
              });
          } else {
            yield* Deferred.succeed(lost, new CodexErrors.CodexAppServerInputStreamEndedError({}));
          }
          yield* Fiber.join(terminal);
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const continued = projection.runs.find(
            (run) => run.restartContinuationOfRunId !== undefined,
          );
          assert.equal(continued?.status, outcome === "completed" ? "completed" : "failed");
          const turn = projection.providerTurns.find(
            (item) => item.runAttemptId === continued?.activeAttemptId,
          );
          assert.equal(turn?.status, outcome === "completed" ? "completed" : "failed");
          assert.equal(turn?.nativeTurnRef?.nativeId, nativeTurnId);
          assert.isUndefined(turn?.survivingRestart);
          if (outcome === "completed") {
            assert.lengthOf(
              projection.turnItems.filter(
                (item) =>
                  item.runId === continued?.id &&
                  item.type === "assistant_message" &&
                  item.text === "native survivor result",
              ),
              1,
            );
          } else {
            const detail =
              outcome === "gone"
                ? "The Codex process stopped while the turn that ran across the restart was still running."
                : "GOAT could not confirm the Codex process from before the restart stopped.";
            assert.isTrue(
              projection.turnItems.some(
                (item) =>
                  item.runId === continued?.id &&
                  item.type === "error" &&
                  item.failure.message === detail,
              ),
            );
            const sql = yield* SqlClient.SqlClient;
            const effects = yield* sql<{
              effect_id: string;
            }>`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId} AND effect_type = 'provider-runtime.continue'`;
            assert.lengthOf(effects, 1);
            if (outcome === "unknown" || outcome === "leftovers")
              assert.equal(
                (yield* survivorService.ensureAdmission(threadId).pipe(Effect.exit))._tag,
                "Failure",
              );
          }
          if (queued) {
            yield* Deferred.await(nextStarted);
            const outbox = yield* EffectOutbox.EffectOutboxV2;
            yield* outbox.awaitSettled("queued-after-survivor");
            const effect = yield* outbox.get("queued-after-survivor");
            assert.equal(effect._tag, "Some");
            if (effect._tag === "Some") assert.equal(effect.value.status, "succeeded");
          }
          assert.isFalse(yield* Deferred.isDone(earlyStart));
          assert.equal(starts, queued ? 2 : 1);
        }).pipe(
          Effect.provide(
            Layer.merge(
              ProviderReplayHarness.layerWithRegistry(scenario, registry, {
                databaseLayer: crashDbLayer,
                recoverOnStartup: true,
                continueThreadsAfterServerUpdate: false,
              }),
              crashDbLayer,
            ).pipe(Layer.provide(shared)),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

it.effect(
  "a continuation adopts the Codex turn still running after a restart without sending turn/start",
  () => runRestartScenario("completed"),
);
it.effect("verified survivor session loss fails once without scheduling another continuation", () =>
  runRestartScenario("gone"),
);
it.effect("unverified survivor session loss blocks admission and schedules no continuation", () =>
  runRestartScenario("unknown"),
);
it.effect("session loss with possible process leftovers blocks admission without continuing", () =>
  runRestartScenario("leftovers"),
);

it.effect("a queued start waits for the survivor waiter before sending turn/start", () =>
  runRestartScenario("completed", true),
);
