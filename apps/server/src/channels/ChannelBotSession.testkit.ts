/** The GOAT Bot session harness: a scripted front desk and helpers shared by session tests. */
import type { ChannelReceptionInput, ChannelTask, ChannelTaskId } from "@goat/contracts";
import { ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { taskIdFor } from "./channelIds.ts";
import {
  defaultScript,
  goatInput,
  makeHarness,
  modelSelection,
  rpcContext,
} from "./testkit/ChannelHarness.ts";

export const botModel = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-luna",
} as const;

/** "look:" starts a GOAT Bot turn, "stop:<task>" stops one, "more:<task> text" follows one up. */
const script = (input: ChannelReceptionInput) => {
  const text = input.inputText ?? "";
  if (input.mode === "input" && text.startsWith("look:"))
    return Effect.succeed({
      replyText: "Looking now.",
      action: {
        type: "run_turn" as const,
        title: text.slice(5).trim(),
        instruction: text.slice(5).trim(),
      },
    });
  if (input.mode === "input" && text.startsWith("stop:"))
    return Effect.succeed({
      replyText: "Stopping.",
      action: { type: "stop_work" as const, taskId: text.slice(5).trim() as ChannelTaskId },
    });
  if (input.mode === "input" && text.startsWith("answer:")) {
    const [taskId, questionId, ...answer] = text.slice(7).split(" ");
    return Effect.succeed({
      replyText: "Passing that on.",
      action: {
        type: "answer_question" as const,
        taskId: taskId as ChannelTaskId,
        questionId: questionId as never,
        answer: answer.join(" "),
      },
    });
  }
  if (input.mode === "input" && text.startsWith("more:"))
    return Effect.succeed({
      replyText: "Passing that on.",
      action: { type: "follow_up" as const, taskId: text.slice(5).split(" ")[0] as ChannelTaskId },
    });
  return defaultScript(input);
};

export const sessionHarness = () => {
  const harness = makeHarness({
    botWorkspace: true,
    settingsLayer: ServerSettings.layerTest({
      textGenerationModelSelection: modelSelection,
      defaultRuntimeMode: "full-access",
      goatBotModelSelection: botModel,
    }).pipe(Layer.orDie),
  });
  harness.script.current = script;
  return harness;
};

/** One message from the person, read and dispatched, with worker runs reconciled. */
export const ask = (text: string, key: string, context: typeof rpcContext = rpcContext) =>
  Effect.gen(function* () {
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const reception = yield* ChannelReceptionService.ChannelReceptionService;
    yield* runtime.drain;
    const ingested = yield* gateway.ingest(goatInput(text, key), context);
    yield* reception.receive(ingested.inputId, runtime.ownerToken);
    yield* runtime.drain;
    yield* reports.reconcile(runtime.ownerToken);
    // A stop or follow-up creates no task; callers that started one read it.
    return (yield* ledger.getTask(taskIdFor(ingested.inputId, 0)))?.task as ChannelTask;
  });

export const settle = Effect.gen(function* () {
  const runtime = yield* ChannelRuntime.ChannelRuntime;
  const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
  yield* reports.reconcile(runtime.ownerToken);
  yield* runtime.drain;
});

export const current = (taskId: ChannelTaskId) =>
  ChannelLedger.ChannelLedger.pipe(
    Effect.flatMap((ledger) => ledger.getTask(taskId)),
    Effect.flatMap((stored) =>
      stored === undefined
        ? Effect.die(new Error("no task " + taskId))
        : Effect.succeed(stored.task),
    ),
  );

/** The thread's run ids in order, and whether a send steered into them. */
export const runsOf = (harness: ReturnType<typeof sessionHarness>, threadId: ThreadId) =>
  harness.world.runs.get(threadId) ?? [];
