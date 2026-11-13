import { assert, it } from "@effect/vitest";
import { ChannelInputId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { turnSteerIdsFor } from "./channelIds.ts";
import { LedgerCallHolds } from "./testkit/dispatchRace.ts";
import {
  slackInput,
  makeHarness,
  slackContext,
  setupBot,
  linkSlackUser,
} from "./testkit/ChannelHarness.ts";

const receiveTwo = Effect.gen(function* () {
  yield* setupBot;
  yield* linkSlackUser();
  const runtime = yield* ChannelRuntime.ChannelRuntime;
  assert.isTrue(yield* runtime.claimForWork);
  const gateway = yield* ChannelGateway.ChannelGateway;
  const reception = yield* ChannelReceptionService.ChannelReceptionService;
  for (const key of ["first-3165", "second-3165"]) {
    const input = yield* gateway.ingest(
      slackInput("do: inspect the build", key, key),
      slackContext,
    );
    yield* reception.receive(input.inputId, runtime.ownerToken);
  }
  yield* runtime.runPass;
  yield* runtime.settle([]);
  const ledger = yield* ChannelLedger.ChannelLedger;
  const tasks = yield* ledger.listTasksByStatus(["received"]);
  assert.lengthOf(tasks, 2);
  return { runtime, ledger, first: tasks[0]!.task, second: tasks[1]!.task };
});

const logging = () => {
  const logs: string[] = [];
  return {
    logs,
    layer: Logger.layer(
      [
        Logger.make(({ message, logLevel }) => {
          if (logLevel === "Warn") logs.push(JSON.stringify(message));
        }),
      ],
      {
        mergeWithExisting: false,
      },
    ),
  };
};

it.effect(
  "regression #3165: one task's failed dispatch is logged with its id and the same pass dispatches the next task",
  () => {
    const harness = makeHarness({
      providerInstances: [
        { instanceId: "codex", displayName: "Local Codex", weeklyUsedPercent: 80 },
      ],
    });
    const log = logging();
    return Effect.gen(function* () {
      const { runtime, ledger, first, second } = yield* receiveTwo;
      yield* (yield* LedgerCallHolds).failNext(
        "getRemoteWorker",
        new ChannelLedger.ChannelLedgerError({ reason: "persistence", detail: "injected" }),
        (id) => id === first.taskId,
      );
      yield* runtime.runPass;
      assert.strictEqual((yield* ledger.getTask(first.taskId))!.task.status, "received");
      assert.notStrictEqual((yield* ledger.getTask(second.taskId))!.task.status, "received");
      assert.isTrue(
        log.logs.some(
          (entry) => entry.includes("channel task step failed") && entry.includes(first.taskId),
        ),
      );
      yield* runtime.runPass;
      assert.notStrictEqual((yield* ledger.getTask(first.taskId))!.task.status, "received");
    }).pipe(
      Effect.provide(
        Layer.merge(Layer.provideMerge(LedgerCallHolds.layer, harness.layer), log.layer),
      ),
    );
  },
);

it.effect("contract #3165: a lost owner still ends the pass", () => {
  const harness = makeHarness({
    providerInstances: [{ instanceId: "codex", displayName: "Local Codex", weeklyUsedPercent: 80 }],
  });
  const log = logging();
  return Effect.gen(function* () {
    const { runtime, first } = yield* receiveTwo;
    const error = new ChannelLedger.ChannelLedgerError({
      reason: "ownership_lost",
      detail: "injected",
    });
    yield* (yield* LedgerCallHolds).failNext("getRemoteWorker", error, (id) => id === first.taskId);
    const result = yield* Effect.exit(runtime.runPass);
    assert.isTrue(Exit.isFailure(result));
    if (Exit.isFailure(result)) assert.include(String(result.cause), "ownership_lost");
    assert.isTrue(
      log.logs.some(
        (entry) => entry.includes("channel task step failed") && entry.includes(first.taskId),
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.merge(Layer.provideMerge(LedgerCallHolds.layer, harness.layer), log.layer),
    ),
  );
});

it.effect(
  "regression #3165: one failed forward is logged with its task id and the same pass handles the next forward",
  () => {
    const harness = makeHarness({
      providerInstances: [
        { instanceId: "codex", displayName: "Local Codex", weeklyUsedPercent: 80 },
      ],
    });
    const log = logging();
    return Effect.gen(function* () {
      const { runtime, ledger } = yield* receiveTwo;
      yield* runtime.runPass;
      const tasks = yield* ledger.listTasksByStatus(["running"]);
      assert.lengthOf(tasks, 2);
      for (const [index, stored] of tasks.entries()) {
        const inputId = ChannelInputId.make(`input:forward-3165-${index}`);
        yield* commitTransition(
          ledger,
          stored,
          {
            type: "task.followup.received",
            payload: {
              inputId,
              text: "follow-up",
              from: "Owner",
              generation: stored.task.generation,
            },
          },
          {
            owner: runtime.ownerToken,
            forward: true,
            pendingAnswerMessageId: turnSteerIdsFor(inputId, "first").messageId,
          },
        );
      }
      const forwards = yield* ledger.listPendingForwards(10);
      assert.lengthOf(forwards, 2);
      const first = forwards[0]!;
      const second = forwards[1]!;
      yield* (yield* LedgerCallHolds).failNext(
        "isForwardPending",
        new ChannelLedger.ChannelLedgerError({ reason: "persistence", detail: "injected" }),
        (sequence) => sequence === first.sequence,
      );
      yield* runtime.runPass;
      assert.isTrue(yield* ledger.isForwardPending(first.sequence));
      assert.isFalse(yield* ledger.isForwardPending(second.sequence));
      assert.isTrue(
        log.logs.some(
          (entry) =>
            entry.includes("channel task step failed") && entry.includes(first.event.taskId),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.merge(Layer.provideMerge(LedgerCallHolds.layer, harness.layer), log.layer),
      ),
    );
  },
);
