import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ServerCommand,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { makeComputerUseSteering } from "./ComputerUseSteering.ts";
import type * as CuaDriver from "./CuaDriver.ts";

const at = (minute: number) => DateTime.makeUnsafe(minute * 60_000);

interface Thread {
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly message: string;
    readonly from: number;
    readonly to?: number;
    readonly status?: string;
  }>;
  readonly runtimeMode?: string;
}

/** Projection records for a few threads; a message id names its own fields. */
const steering = (
  threads: Record<string, Thread>,
  messages: Record<
    string,
    {
      readonly createdAt: number;
      readonly scheduledTaskId?: string;
      readonly senderThreadId?: string;
    }
  >,
) => {
  const getThreadRecords = (id: ThreadId) => {
    const thread = threads[id];
    // A thread this host does not have reads as no record, the way the projection answers.
    if (thread === undefined) return Effect.succeed({ thread: undefined, runs: [], messages: [] });
    const runs = thread.runs.map((run) => ({
      id: RunId.make(run.id),
      userMessageId: MessageId.make(run.message),
      requestedAt: at(run.from),
      completedAt: run.to === undefined ? null : at(run.to),
      status: run.status ?? (run.to === undefined ? "running" : "completed"),
    }));
    return Effect.succeed({
      thread: {
        createdAt: at(0),
        runtimeMode: thread.runtimeMode ?? "full-access",
        lineage: { parentThreadId: null, relationshipToParent: null },
      },
      runs,
      messages: thread.runs.flatMap((run) => {
        const message = messages[run.message];
        return message === undefined
          ? []
          : [
              {
                id: MessageId.make(run.message),
                createdAt: at(message.createdAt),
                ...(message.scheduledTaskId === undefined
                  ? {}
                  : { scheduledTaskId: message.scheduledTaskId }),
                ...(message.senderThreadId === undefined
                  ? {}
                  : { senderThreadId: ThreadId.make(message.senderThreadId) }),
              },
            ];
      }),
      runtimeRequests: [],
    });
  };
  return makeComputerUseSteering({
    orchestrator: { getThreadRecords } as unknown as Pick<
      Orchestrator.OrchestratorV2["Service"],
      "getThreadRecords"
    >,
    leases: Option.none(),
    cuaDriver: Option.some({
      enabled: Effect.succeed(true),
    } as unknown as CuaDriver.CuaDriver["Service"]),
  });
};

const promote = (queuedRunId: string, targetRunId: string): OrchestrationV2ServerCommand => ({
  type: "queued-message.promote-to-steer",
  commandId: CommandId.make("promote"),
  threadId: ThreadId.make("mine"),
  queuedRunId: RunId.make(queuedRunId),
  targetRunId: RunId.make(targetRunId),
});

it.effect(
  "a promotion weighs the sender as it was when it wrote the message, not its latest turn",
  () =>
    Effect.gen(function* () {
      const admitted = yield* steering(
        {
          mine: {
            runs: [
              { id: "typed", message: "m-typed", from: 1 },
              { id: "queued", message: "m-peer", from: 3, status: "queued" },
            ],
          },
          // The peer wrote while a schedule ran it; a person typed into it afterwards.
          peer: {
            runs: [
              { id: "cron", message: "p-cron", from: 2, to: 4 },
              { id: "later", message: "p-typed", from: 5 },
            ],
          },
        },
        {
          "m-typed": { createdAt: 1 },
          "m-peer": { createdAt: 3, senderThreadId: "peer" },
          "p-cron": { createdAt: 2, scheduledTaskId: "task-1" },
          "p-typed": { createdAt: 5 },
        },
      )
        .admit(promote("queued", "typed"))
        .pipe(Effect.result);
      assert.equal(admitted._tag, "Failure");
    }),
);

it.effect("a promotion into a turn whose origin cannot be read stays queued", () =>
  Effect.gen(function* () {
    const admitted = yield* steering(
      {
        // The running turn's message is missing, so who started it is unknown.
        mine: {
          runs: [
            { id: "lost", message: "m-lost", from: 1 },
            { id: "queued", message: "m-cron", from: 3, status: "queued" },
          ],
        },
      },
      { "m-cron": { createdAt: 3, scheduledTaskId: "task-1" } },
    )
      .admit(promote("queued", "lost"))
      .pipe(Effect.result);
    assert.equal(admitted._tag, "Failure");
  }),
);

it.effect(
  "an agent's answer is weighed by the run sending it, not a follow-up queued behind it",
  () =>
    Effect.gen(function* () {
      const admitted = yield* steering(
        {
          mine: { runs: [{ id: "typed", message: "m-typed", from: 1 }] },
          // A schedule runs the peer now; a person's follow-up waits behind it.
          peer: {
            runs: [
              { id: "cron", message: "p-cron", from: 1 },
              { id: "follow-up", message: "p-typed", from: 2, status: "queued" },
            ],
          },
        },
        {
          "m-typed": { createdAt: 1 },
          "p-cron": { createdAt: 1, scheduledTaskId: "task-1" },
          "p-typed": { createdAt: 2 },
        },
      ).admit({
        type: "runtime-request.respond",
        commandId: CommandId.make("answer"),
        threadId: ThreadId.make("mine"),
        requestId: RuntimeRequestId.make("question"),
        answers: { next: "go" },
        respondedBy: {
          type: "agent",
          threadId: ThreadId.make("peer"),
          environmentId: null,
          title: null,
          reason: "Answering for the peer",
        },
      });
      assert.isFalse("answerSteersRunId" in admitted);
    }),
);

it.effect("a promotion into a turn whose sender cannot be read stays queued", () =>
  Effect.gen(function* () {
    const admitted = yield* steering(
      {
        // The running turn came from a thread this host no longer has.
        mine: {
          runs: [
            { id: "sent", message: "m-sent", from: 1 },
            { id: "queued", message: "m-cron", from: 3, status: "queued" },
          ],
        },
      },
      {
        "m-sent": { createdAt: 1, senderThreadId: "gone" },
        "m-cron": { createdAt: 3, scheduledTaskId: "task-1" },
      },
    )
      .admit(promote("queued", "sent"))
      .pipe(Effect.result);
    assert.equal(admitted._tag, "Failure");
  }),
);
