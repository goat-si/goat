import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { AcpProviderCapabilitiesV2 } from "@goat/provider-acp/server/adapter";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { type CapturedTurn, makeTestAdapter } from "./testing/providerSwitchAdapter.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const driver = ProviderDriverKind.make("antigravity");
const instanceId = ProviderInstanceId.make("antigravity-test");
const modelSelection = { instanceId, model: "gemini-test" };

it.live.each(["ok", "ensure", "missing"] as const)(
  "Antigravity edit replays kept history; fresh-session failure=%s",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `antigravity-rollback-${mode}`;
        const threadId = ThreadId.make(`thread:${name}`);
        const projectId = ProjectId.make(`project:${name}`);
        const cwd = yield* checkpointWorkspace(name);
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const generation = yield* Ref.make(0);
        const failEnsure = yield* Ref.make(false);
        let omitSession = false;
        const base = makeTestAdapter({
          instanceId,
          driver,
          capabilities: AcpProviderCapabilitiesV2,
          modelSelection,
          responseByRunOrdinal: { 1: "noted", 2: "noted", 3: "noted" },
          capturedTurns,
          injectedHistory,
          nativeThreadGeneration: generation,
          rollback: "replaces_native_thread",
        });
        const adapter = {
          ...base,
          openSession: (input: Parameters<typeof base.openSession>[0]) =>
            base.openSession(input).pipe(
              // Exercise an adapter that omits required session metadata.
              Effect.map(
                (session) =>
                  ({
                    ...session,
                    get providerSession() {
                      return omitSession ? undefined : session.providerSession;
                    },
                    ensureThread: (request: Parameters<typeof session.ensureThread>[0]) =>
                      Ref.get(failEnsure).pipe(
                        Effect.flatMap((fail) =>
                          fail
                            ? Effect.fail(
                                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                                  driver,
                                  threadId: request.threadId,
                                  cause: "simulated fresh session failure",
                                }),
                              )
                            : session.ensureThread(request),
                        ),
                      ),
                  }) as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
              ),
            ),
        };
        const registry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const send = Effect.fn("AntigravityRollbackTest.send")(function* (
            ordinal: number,
            text: string,
          ) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${name}:${ordinal}`),
              threadId,
              messageId: MessageId.make(`${name}:${ordinal}`),
              createdBy: "user",
              creationSource: "web",
              text,
              attachments: [],
              modelSelection,
              dispatchMode: { type: "start_immediately" },
            });
            if (mode === "missing" && ordinal === 3) {
              yield* worker.drain();
              return;
            }
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.threadId === threadId &&
                  event.payload.ordinal === ordinal &&
                  (event.payload.status === "completed" || event.payload.status === "failed"),
              ),
              Stream.runHead,
            );
            yield* worker.drain();
          });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${name}:create`),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Edit from here",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* send(1, "My favourite colour is teal.");
          yield* send(2, "My favourite animal is an otter.");
          const before = yield* orchestrator.getThreadProjection(threadId);
          const checkpoint = before.checkpoints.find(
            (item) => item.appRunOrdinal === 1 && item.status === "ready",
          );
          if (checkpoint === undefined) return yield* Effect.die("Missing kept checkpoint");
          yield* orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId: CommandId.make(`${name}:rollback`),
            threadId,
            scopeId: checkpoint.scopeId,
            checkpointId: checkpoint.id,
            restoreFiles: false,
          });
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.threadId === threadId &&
                event.payload.ordinal === 2 &&
                event.payload.status === "rolled_back",
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          const afterRollback = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            afterRollback.runs.map((run) => run.status),
            ["completed", "rolled_back"],
          );
          const keptMessages = afterRollback.messages.map((message) => ({
            id: message.id,
            text: message.text,
          }));
          const beforeGeneration = yield* Ref.get(generation);
          yield* Ref.set(failEnsure, mode === "ensure");
          omitSession = mode === "missing";
          yield* send(3, "What did I say first?");
          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            after.messages
              .filter((message) => keptMessages.some((old) => old.id === message.id))
              .map((message) => ({ id: message.id, text: message.text })),
            keptMessages,
          );
          if (mode !== "ok") {
            assert.equal(after.runs.at(-1)?.status, "failed");
            assert.isTrue(
              after.turnItems.some(
                (item) =>
                  item.type === "error" &&
                  item.failure.class === "provider_error" &&
                  item.failure.message.includes(
                    mode === "missing"
                      ? "did not report its session details"
                      : "simulated fresh session failure",
                  ),
              ),
            );
          } else {
            assert.equal(after.runs.at(-1)?.status, "completed");
            assert.isAbove(yield* Ref.get(generation), beforeGeneration);
            const delivered = (yield* Ref.get(capturedTurns)).at(-1)?.text ?? "";
            const history = yield* encodeJson(yield* Ref.get(injectedHistory));
            assert.include(delivered + history, "favourite colour is teal");
            assert.notInclude(delivered + history, "favourite animal is an otter");
          }
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name,
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "readOnly" },
                },
              },
              registry,
              { effectWorkerMaxAttempts: 1 },
            ),
          ),
        );
      }),
    ),
);
