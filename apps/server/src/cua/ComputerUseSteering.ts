/**
 * Ways a message joins a running turn, weighed against how much of the screen that turn may use
 * (gateUnattendedSteering). A message whose origin reaches less waits as the thread's next turn,
 * which is admitted on its own, so it cannot use what the running turn was given: a send that
 * asked to steer queues, a promotion is refused and stays queued, and an agent's answer to a
 * question is delivered as the next turn.
 *
 * @module ComputerUseSteering
 */
import type {
  OrchestrationV2Command,
  OrchestrationV2ServerCommand,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { gateUnattendedSteering, projectionOriginReads } from "./ComputerUseOrigin.ts";
import type * as CuaDriver from "./CuaDriver.ts";

type DispatchMode = Extract<
  OrchestrationV2Command,
  { readonly type: "message.dispatch" }
>["dispatchMode"];

/** Where a message came from, as far as steering is concerned. */
export interface SteeringSource {
  readonly threadId: ThreadId;
  readonly scheduledTaskId?: string | undefined;
  readonly senderThreadId?: ThreadId | undefined;
  readonly messageId?: string | undefined;
}

export const makeComputerUseSteering = (deps: {
  readonly orchestrator: Pick<Orchestrator.OrchestratorV2["Service"], "getThreadRecords">;
  readonly leases: Option.Option<ComputerUseLeases.ComputerUseLeases["Service"]>;
  readonly cuaDriver: Option.Option<CuaDriver.CuaDriver["Service"]>;
}) => {
  const reads = projectionOriginReads({
    getThreadRecords: (id, fields, filter) =>
      deps.orchestrator.getThreadRecords(id, fields, filter),
    channelOrigin: (id) =>
      Option.isSome(deps.leases) ? deps.leases.value.channelOrigin(id) : Effect.undefined,
  });

  /** The mode a message gets: a steer it may not make waits as the next turn instead. */
  const steeringMode = Effect.fn("ComputerUseSteering.steeringMode")(function* (
    source: SteeringSource,
    mode: DispatchMode,
  ) {
    if (
      (mode.type !== "steer_active" && mode.type !== "restart_active") ||
      (source.scheduledTaskId === undefined && source.senderThreadId === undefined)
    )
      return mode;
    // With computer use off no turn holds a driver, so steering stays as it always was,
    // including for senders on other machines this host cannot classify.
    if (Option.isNone(deps.cuaDriver) || !(yield* deps.cuaDriver.value.enabled)) return mode;
    const gated = yield* gateUnattendedSteering(reads, source, mode);
    if (gated.queued)
      yield* Effect.logInfo(
        "A message from work with less of the screen waits as the next turn instead of steering.",
        { threadId: source.threadId, messageId: source.messageId },
      );
    return gated.mode;
  });

  const refuse = (command: OrchestrationV2ServerCommand, cause: string) =>
    new Orchestrator.OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause,
    });

  /** Holds a promotion or an agent's answer to the same rule as a steer; others pass unchanged. */
  const admit = Effect.fn("ComputerUseSteering.admit")(function* (
    command: OrchestrationV2ServerCommand,
  ) {
    if (command.type === "queued-message.promote-to-steer") {
      const records = yield* deps.orchestrator
        .getThreadRecords(command.threadId, ["runs", "messages"])
        .pipe(Effect.mapError((cause) => refuse(command, String(cause))));
      const queued = records.runs.find((run) => run.id === command.queuedRunId);
      const message = records.messages.find((item) => item.id === queued?.userMessageId);
      const mode = yield* steeringMode(
        {
          threadId: command.threadId,
          scheduledTaskId: message?.scheduledTaskId,
          senderThreadId: message?.senderThreadId,
          messageId: message?.id,
        },
        { type: "steer_active", targetRunId: command.targetRunId },
      );
      if (mode.type !== "steer_active")
        return yield* refuse(
          command,
          "This message comes from work with less of the screen than the running turn, so it stays queued and runs as its own turn.",
        );
      return command;
    }
    if (
      command.type !== "runtime-request.respond" ||
      command.respondedBy?.type !== "agent" ||
      command.respondedBy.environmentId !== null
    )
      return command;
    const records = yield* deps.orchestrator
      .getThreadRecords(command.threadId, ["runs"])
      .pipe(Effect.mapError((cause) => refuse(command, String(cause))));
    const running = records.runs.find((run) => run.status === "running");
    if (running === undefined) return command;
    const mode = yield* steeringMode(
      { threadId: command.threadId, senderThreadId: command.respondedBy.threadId },
      { type: "steer_active", targetRunId: running.id },
    );
    return mode.type === "steer_active" ? command : { ...command, answerAsNextTurn: true };
  });

  return { steeringMode, admit };
};
