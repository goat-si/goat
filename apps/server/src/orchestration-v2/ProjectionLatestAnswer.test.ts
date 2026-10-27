import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  withWebhookService,
  webhookTaskInput,
} from "../scheduledTasks/ScheduledRunFixture.testkit.ts";
import { answerExcerpt } from "./ProjectionLatestAnswer.ts";
import { applyToProjection, emptyProjection } from "./ProjectionStore.ts";

it("flattens an answer to one line and cuts it without splitting a character", () => {
  assert.equal(answerExcerpt("  Done.\n\nPR   opened  "), "Done. PR opened");
  assert.isUndefined(answerExcerpt(" \n\t "));
  const long = answerExcerpt("a".repeat(158) + "😀😀");
  assert.equal(long, "a".repeat(158) + "…");
  assert.isAtMost(long?.length ?? 0, 160);
});

type Scenario = (input: {
  readonly initial: OrchestrationV2ThreadProjection;
  readonly run: OrchestrationV2Run;
  readonly at: (seconds: number) => DateTime.Utc;
  readonly answer: (
    id: string,
    text: string,
    options?: {
      readonly run?: OrchestrationV2Run;
      readonly node?: NodeId | null;
      readonly at?: number;
    },
  ) => OrchestrationV2DomainEvent;
  readonly node: (
    id: string,
    kind: OrchestrationV2ExecutionNode["kind"],
    parent: NodeId | null,
    run?: OrchestrationV2Run,
  ) => OrchestrationV2DomainEvent;
  readonly runUpdate: (payload: OrchestrationV2Run, at?: number) => OrchestrationV2DomainEvent;
}) => ReadonlyArray<OrchestrationV2DomainEvent>;

// Writes the events through the SQL projection and replays them in memory; both must agree.
const excerptsAfter = (scenario: Scenario) =>
  withWebhookService(
    ({ service, sink, projections }) =>
      Effect.gen(function* () {
        const task = (yield* service.upsert(
          yield* webhookTaskInput({ schedule: { type: "interval", everyMs: 60000 } }),
        )).task;
        const ran = yield* service.runNow({ id: task.id });
        const initial = yield* projections.getThreadProjection(ran.threadId!);
        const run = initial.runs[0]!;
        const now = yield* DateTime.now;
        const at = (seconds: number) => DateTime.add(now, { seconds });
        let sequence = 0;
        const eventId = (name: string) => EventId.make(name + "-" + sequence++);
        const events = scenario({
          initial,
          run,
          at,
          answer: (id, text, options = {}) => {
            const owner = options.run ?? run;
            const time = at(options.at ?? 1);
            const payload: OrchestrationV2ConversationMessage = {
              ...initial.messages[0]!,
              id: MessageId.make(id),
              role: "assistant",
              runId: owner.id,
              nodeId: options.node === undefined ? owner.rootNodeId : options.node,
              text,
              streaming: false,
              createdAt: time,
              updatedAt: time,
            };
            return {
              id: eventId(id),
              type: "message.updated",
              threadId: run.threadId,
              occurredAt: time,
              payload,
            };
          },
          node: (id, kind, parent, owner = run) => ({
            id: eventId(id),
            type: "node.updated",
            threadId: run.threadId,
            occurredAt: at(1),
            payload: {
              id: NodeId.make(id),
              threadId: run.threadId,
              runId: owner.id,
              parentNodeId: parent,
              rootNodeId: owner.rootNodeId ?? NodeId.make(id),
              kind,
              status: "completed",
              countsForRun: true,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: at(1),
              completedAt: at(1),
            },
          }),
          runUpdate: (payload, seconds = 2) => ({
            id: eventId("run"),
            type: "run.updated",
            threadId: run.threadId,
            occurredAt: at(seconds),
            payload,
          }),
        });
        yield* sink.write({ events });
        let replay = initial;
        for (const event of events) replay = applyToProjection(replay, event);
        const shell = yield* projections.getThreadShell(run.threadId);
        return { sql: shell?.latestAnswerExcerpt, replay: replay.thread.latestAnswerExcerpt };
      }),
    { runStatus: "queued" },
  );

const expectExcerpt = (scenario: Scenario, expected: string | undefined) =>
  excerptsAfter(scenario).pipe(
    Effect.map((excerpts) => assert.deepStrictEqual(excerpts, { sql: expected, replay: expected })),
  );

it.effect("takes the answer from the root turn's own answer node, not a native subagent's", () =>
  expectExcerpt(({ run, answer, node, runUpdate, at }) => {
    const rooted = { ...run, rootNodeId: NodeId.make("root") };
    return [
      runUpdate(rooted, 1),
      node("answer-node", "assistant_message", rooted.rootNodeId, rooted),
      answer("answer", "Fixed the bug.\nPR #12 is open.", {
        run: rooted,
        node: NodeId.make("answer-node"),
      }),
      node("subagent", "subagent", rooted.rootNodeId, rooted),
      node("subagent-answer-node", "assistant_message", NodeId.make("subagent"), rooted),
      answer("subagent-answer", "Subagent notes", {
        run: rooted,
        node: NodeId.make("subagent-answer-node"),
        at: 2,
      }),
      runUpdate({ ...rooted, status: "completed", completedAt: at(3) }, 3),
    ];
  }, "Fixed the bug. PR #12 is open."),
);

it.effect("skips a blank newest answer and breaks a timestamp tie the same way everywhere", () =>
  expectExcerpt(
    ({ run, answer, runUpdate, at }) => [
      answer("Bravo", "Upper case id"),
      answer("alpha", "Lower case id"),
      answer("zz-blank", "\n\t ", { at: 2 }),
      runUpdate({ ...run, status: "completed", completedAt: at(3) }, 3),
    ],
    "Lower case id",
  ),
);

it.effect("an older run's metadata update does not bring back its answer over a newer run's", () =>
  expectExcerpt(({ run, answer, runUpdate, at }) => {
    const newer = { ...run, id: RunId.make("run-newer"), ordinal: run.ordinal + 1 };
    const older = { ...run, status: "completed" as const, completedAt: at(2) };
    return [
      answer("old-answer", "Older answer"),
      runUpdate(older, 2),
      runUpdate({ ...newer, status: "completed", completedAt: at(4) }, 4),
      answer("new-answer", "Newer answer", { run: newer, at: 3 }),
      runUpdate({ ...older, completionNotification: "notify" }, 5),
    ];
  }, "Newer answer"),
);

it.effect("an answer finalized after its run completed still becomes the excerpt", () =>
  expectExcerpt(
    ({ run, answer, runUpdate, at }) => [
      runUpdate({ ...run, status: "completed", completedAt: at(2) }, 2),
      answer("late", "Finalized late", { at: 3 }),
    ],
    "Finalized late",
  ),
);

it.effect("rolling back the only completed run clears the excerpt", () =>
  expectExcerpt(
    ({ run, answer, runUpdate, at }) => [
      answer("answer", "Discarded answer"),
      runUpdate({ ...run, status: "completed", completedAt: at(2) }, 2),
      runUpdate({ ...run, status: "rolled_back", completedAt: at(2) }, 3),
    ],
    undefined,
  ),
);

it.effect("a thread payload, including a fork's copied one, never sets the excerpt", () =>
  expectExcerpt(
    ({ initial, run, answer, runUpdate, at }) => [
      answer("answer", "Real answer"),
      runUpdate({ ...run, status: "completed", completedAt: at(2) }, 2),
      {
        id: EventId.make("stale-thread"),
        type: "thread.metadata-updated",
        threadId: run.threadId,
        occurredAt: at(3),
        payload: { ...initial.thread, latestAnswerExcerpt: "Copied from a fork source" },
      },
    ],
    "Real answer",
  ),
);

it.effect("a fork created with its source's excerpt starts without one", () =>
  withWebhookService(
    ({ service, sink, projections }) =>
      Effect.gen(function* () {
        const task = (yield* service.upsert(
          yield* webhookTaskInput({ schedule: { type: "interval", everyMs: 60000 } }),
        )).task;
        const ran = yield* service.runNow({ id: task.id });
        const source = yield* projections.getThreadProjection(ran.threadId!);
        const created: OrchestrationV2DomainEvent = {
          id: EventId.make("fork-created"),
          type: "thread.created",
          threadId: ThreadId.make("thread-fork"),
          occurredAt: yield* DateTime.now,
          payload: {
            ...source.thread,
            id: ThreadId.make("thread-fork"),
            latestAnswerExcerpt: "An answer after the fork point",
          },
        };
        yield* sink.write({ events: [created] });
        if (created.type !== "thread.created") return;
        assert.isUndefined(
          (yield* projections.getThreadShell(ThreadId.make("thread-fork")))?.latestAnswerExcerpt,
        );
        assert.isUndefined(emptyProjection(created).thread.latestAnswerExcerpt);
      }),
    { runStatus: "queued" },
  ),
);
