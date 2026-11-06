import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { CLAUDE_MODEL_SELECTION, CODEX_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { type CapturedTurn, makeTestAdapter } from "./testing/providerSwitchAdapter.ts";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

const waitForIdle = Effect.fn("ProviderSwitchTest.waitForIdle")(function* (
  targetThreadId: ThreadId,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const isIdle = (projection: OrchestrationV2ThreadProjection) =>
    projection.runs.every(
      (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
    );
  const afterSequence = yield* eventSink.latestSequence();
  const current = yield* orchestrator.getThreadProjection(targetThreadId);
  if (isIdle(current)) {
    return current;
  }
  // Projections commit with their events, so each later event is the only time to re-read.
  const [idle] = yield* eventSink.stream({ afterSequence }).pipe(
    Stream.mapEffect(() => orchestrator.getThreadProjection(targetThreadId)),
    Stream.filter(isIdle),
    Stream.take(1),
    Stream.runCollect,
  );
  if (idle === undefined) {
    return yield* Effect.die(
      new Error("Provider switch test event stream ended before the thread went idle"),
    );
  }
  return idle;
});

describe("fresh provider context", () => {
  it.live.each(["immediately", "behind a running turn"] as const)(
    "starts a fresh provider session %s and never hands earlier runs to a later provider",
    (variant) =>
      Effect.scoped(
        Effect.gen(function* () {
          const queued = variant !== "immediately";
          const key = queued ? "queued" : "immediate";
          const cwd = yield* checkpointWorkspace(`fresh-context-${key}`);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const closedSessions = yield* Ref.make<ReadonlyArray<string>>([]);
          // A queued start has nobody to refuse, so a busy session must stay up.
          const backgroundWork = yield* Ref.make(queued);
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            makeTestAdapter({
              instanceId: CLAUDE_MODEL_SELECTION.instanceId,
              driver: CLAUDE_DRIVER,
              capabilities: ClaudeProviderCapabilitiesV2,
              modelSelection: CLAUDE_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
              closedSessions,
              backgroundWork,
              nativeThreadGeneration: yield* Ref.make(0),
              ...(queued
                ? { holdFirstTurn: started, releaseFirstTurn: release, holdRunOrdinal: 2 }
                : {}),
            }),
            makeTestAdapter({
              instanceId: CODEX_MODEL_SELECTION.instanceId,
              driver: CODEX_DRIVER,
              capabilities: CodexProviderCapabilitiesV2,
              modelSelection: CODEX_MODEL_SELECTION,
              responseByRunOrdinal: {},
              capturedTurns,
            }),
          ]);
          const freshThreadId = ThreadId.make(`thread:fresh-context:${key}`);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const send = (
              name: string,
              modelSelection: ModelSelection,
              options: { readonly freshContext?: boolean } = {},
            ) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make(`command:fresh-context:${key}:${name}`),
                threadId: freshThreadId,
                messageId: MessageId.make(`message:fresh-context:${key}:${name}`),
                text: `Prompt ${name}`,
                attachments: [],
                modelSelection,
                ...options,
                // A fresh send must never steer the running turn.
                deliveryIntent: "auto",
                dispatchMode: { type: "start_immediately" },
              });
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:fresh-context:${key}:create`),
              threadId: freshThreadId,
              projectId: ProjectId.make(`project:fresh-context:${key}`),
              title: "Fresh context",
              modelSelection: CLAUDE_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            // Codex keeps a native thread from before the fresh run that must not resume.
            yield* send("zero", CODEX_MODEL_SELECTION);
            yield* worker.drain();
            yield* waitForIdle(freshThreadId);
            yield* send("alpha", CLAUDE_MODEL_SELECTION);
            if (queued) {
              yield* Deferred.await(started);
            } else {
              yield* worker.drain();
              yield* waitForIdle(freshThreadId);
            }
            const firstSession = (yield* orchestrator.getThreadProjection(
              freshThreadId,
            )).providerSessions.find(
              (session) => session.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
            )!;
            yield* send("beta", CLAUDE_MODEL_SELECTION, { freshContext: true });
            if (queued) {
              // Queued before the fresh run started, so it is bound to the old conversation.
              yield* send("gamma", CLAUDE_MODEL_SELECTION);
              const waiting = yield* orchestrator.getThreadProjection(freshThreadId);
              assert.deepEqual(
                waiting.runs.map((run) => run.status),
                ["completed", "running", "queued", "queued"],
              );
              // Steering would send it into the conversation it is meant to leave.
              const promoted = yield* orchestrator
                .dispatch({
                  type: "queued-message.promote-to-steer",
                  commandId: CommandId.make(`command:fresh-context:${key}:promote`),
                  threadId: freshThreadId,
                  queuedRunId: waiting.runs.find((run) => run.freshContext === true)!.id,
                  targetRunId: waiting.runs.find((run) => run.status === "running")!.id,
                })
                .pipe(Effect.flip);
              assert.instanceOf(promoted, Orchestrator.OrchestratorDispatchError);
              assert.include(String(promoted.cause), "fresh session");
              yield* Deferred.succeed(release, undefined);
            }
            yield* worker.drain();
            yield* waitForIdle(freshThreadId);
            // Claude hosts one native thread per session, so an idle old one is closed.
            assert.deepEqual(yield* Ref.get(closedSessions), queued ? [] : [firstSession.id]);
            yield* Ref.set(backgroundWork, false);
            yield* send("delta", CODEX_MODEL_SELECTION);
            yield* worker.drain();
            yield* waitForIdle(freshThreadId);
            yield* worker.drain();
            const projection = yield* orchestrator.getThreadProjection(freshThreadId);
            const turns = yield* Ref.get(capturedTurns);
            const turnFor = (name: string) =>
              turns.find((turn) => turn.text.endsWith(`Prompt ${name}`))!;

            const freshRun = projection.runs.find(
              (run) => run.userMessageId === `message:fresh-context:${key}:beta`,
            )!;
            assert.isTrue(freshRun.freshContext);
            assert.equal(freshRun.contextHandoffId, null);
            assert.isTrue(
              projection.turnItems.some(
                (item) =>
                  item.type === "user_message" &&
                  item.messageId === freshRun.userMessageId &&
                  item.freshContext === true,
              ),
            );
            assert.notEqual(turnFor("beta").providerThreadId, turnFor("alpha").providerThreadId);
            assert.notEqual(turnFor("beta").nativeThreadId, turnFor("alpha").nativeThreadId);
            assert.equal(turnFor("beta").text, "Prompt beta");
            if (queued) {
              assert.equal(turnFor("gamma").providerThreadId, turnFor("beta").providerThreadId);
            }
            const codexTurn = turnFor("delta");
            assert.notEqual(codexTurn.providerThreadId, turnFor("zero").providerThreadId);
            assert.include(codexTurn.text, "Prompt beta");
            assert.notInclude(codexTurn.text, "Prompt alpha");
            assert.notInclude(codexTurn.text, "Prompt zero");
            assert.equal(projection.contextHandoffs.at(-1)!.coveredRunOrdinals.from, 3);
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name: `fresh-context-${key}`,
                  runtimePolicyOverride: {
                    cwd,
                    approvalPolicy: "never",
                    sandboxPolicy: {
                      type: "readOnly",
                      access: { type: "fullAccess" },
                      networkAccess: false,
                    },
                  },
                },
                layerRegistry,
              ),
            ),
          );
        }),
      ),
  );

  it.live("keeps the thread a queued fresh run reserved for that run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("fresh-context-reserved");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
            nativeThreadGeneration: yield* Ref.make(0),
            holdFirstTurn: started,
            releaseFirstTurn: release,
            holdRunOrdinal: 2,
          }),
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
            nativeThreadGeneration: yield* Ref.make(0),
          }),
        ]);
        const reservedThreadId = ThreadId.make("thread:fresh-context-reserved");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const send = (
            name: string,
            modelSelection: ModelSelection,
            options: { readonly freshContext?: boolean } = {},
          ) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:fresh-context-reserved:${name}`),
              threadId: reservedThreadId,
              messageId: MessageId.make(`message:fresh-context-reserved:${name}`),
              text: `Prompt ${name}`,
              attachments: [],
              modelSelection,
              ...options,
              dispatchMode: { type: "queue_after_active" },
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:fresh-context-reserved:create"),
            threadId: reservedThreadId,
            projectId: ProjectId.make("project:fresh-context-reserved"),
            title: "Fresh context reserved",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* send("zero", CODEX_MODEL_SELECTION);
          yield* worker.drain();
          yield* waitForIdle(reservedThreadId);
          yield* send("alpha", CLAUDE_MODEL_SELECTION);
          yield* Deferred.await(started);
          // Queued while no fresh run has started: gamma binds to zero's Codex thread, and
          // delta reserves its own. Once beta starts, gamma must not take delta's thread.
          yield* send("beta", CLAUDE_MODEL_SELECTION, { freshContext: true });
          yield* send("gamma", CODEX_MODEL_SELECTION);
          yield* send("delta", CODEX_MODEL_SELECTION, { freshContext: true });
          yield* Deferred.succeed(release, undefined);
          yield* worker.drain();
          yield* waitForIdle(reservedThreadId);
          yield* worker.drain();
          const turns = yield* Ref.get(capturedTurns);
          const turnFor = (name: string) =>
            turns.find((turn) => turn.text.endsWith(`Prompt ${name}`))!;

          assert.notEqual(turnFor("gamma").providerThreadId, turnFor("zero").providerThreadId);
          assert.notEqual(turnFor("delta").providerThreadId, turnFor("gamma").providerThreadId);
          assert.notEqual(turnFor("delta").nativeThreadId, turnFor("gamma").nativeThreadId);
          assert.equal(turnFor("delta").text, "Prompt delta");
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "fresh-context-reserved",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              },
              layerRegistry,
            ),
          ),
        );
      }),
    ),
  );
});
