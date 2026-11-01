import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  type OrchestrationV2UserInputQuestion,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Answering a question that resumes by message needs no provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "user-input-answers" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const pickQuestion = {
  id: "next",
  header: "Next",
  question: "What next?",
  options: [
    { label: "진행", description: "Keep going", value: "go" },
    { label: "Stop", description: "Stop here", value: "stop" },
  ],
} as const;

/** A pending question that resumes its thread by message, as Codex async questions do. */
const askQuestion = Effect.fn("userInputAnswersTest.askQuestion")(function* (
  name: string,
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(name);
  const requestId = RuntimeRequestId.make(`${name}-request`);
  const nodeId = NodeId.make(`${name}-node`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`${name}-create`),
    createdBy: "user",
    creationSource: "web",
    threadId,
    projectId: ProjectId.make(`${name}-project`),
    title: "Question",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: process.cwd(),
  });
  const shared = { threadId, providerThreadId: null, providerTurnId: null, nativeItemRef: null };
  yield* eventSink.write({
    commandId: CommandId.make(`${name}-seed`),
    events: [
      {
        id: EventId.make(`${name}-node-event`),
        type: "node.updated",
        threadId,
        nodeId,
        occurredAt: now,
        payload: {
          ...shared,
          id: nodeId,
          runId: null,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: "user_input_request",
          status: "waiting",
          countsForRun: false,
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      },
      {
        id: EventId.make(`${name}-request-event`),
        type: "runtime-request.updated",
        threadId,
        nodeId,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      },
      {
        id: EventId.make(`${name}-item-event`),
        type: "turn-item.updated",
        threadId,
        nodeId,
        occurredAt: now,
        payload: {
          ...shared,
          id: TurnItemId.make(`${name}-item`),
          type: "user_input_request",
          runId: null,
          nodeId,
          parentItemId: null,
          ordinal: 0,
          status: "waiting",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          requestId,
          responseMode: "message",
          questions,
        },
      },
    ],
  });
  return { threadId, requestId };
});

it.effect("resolves picked options to their offered values whatever form the pick arrives in", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const question = yield* askQuestion("picked-options", [
      { ...pickQuestion, multiSelect: true, allowCustomAnswer: false },
      { ...pickQuestion, id: "after", question: "And then?" },
      { id: "why", header: "Why", question: "Why?", options: [], required: false },
    ]);
    yield* orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("picked-options-answer"),
      threadId: question.threadId,
      requestId: question.requestId,
      // On an options-only question: decomposed Hangul with spaces and a differently cased label.
      // Elsewhere an exact label, relayed as a one-item list.
      answers: { next: [" 진행 ".normalize("NFD"), "STOP"], after: ["진행"] },
    });
    const answered = yield* orchestrator.getThreadProjection(question.threadId);
    assert.equal(answered.runtimeRequests[0]?.status, "resolved");
    assert.deepEqual(answered.runtimeRequests[0]?.answers, { next: ["go", "stop"], after: ["go"] });
    assert.deepEqual(
      answered.messages.map((message) => message.text),
      ["What next?\n진행, Stop\n\nAnd then?\n진행"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps custom text, even text close to an option, and exact option ids as written", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const spaced = { label: "Spaced", description: "Id", value: " go " };
    const question = yield* askQuestion("custom-answer", [
      { ...pickQuestion, options: [...pickQuestion.options, spaced] },
      { ...pickQuestion, id: "after", question: "And then?" },
      { ...pickQuestion, id: "again", question: "Again?" },
    ]);
    yield* orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("custom-answer-answer"),
      threadId: question.threadId,
      requestId: question.requestId,
      answers: { next: " go ", after: "다른 방법으로", again: "STOP" },
    });
    const answered = yield* orchestrator.getThreadProjection(question.threadId);
    assert.deepEqual(answered.runtimeRequests[0]?.answers, {
      next: " go ",
      after: "다른 방법으로",
      again: "STOP",
    });
    assert.deepEqual(
      answered.messages.map((message) => message.text),
      ["What next?\nSpaced\n\nAnd then?\n다른 방법으로\n\nAgain?\nSTOP"],
    );
  }).pipe(Effect.provide(layerTest)),
);
