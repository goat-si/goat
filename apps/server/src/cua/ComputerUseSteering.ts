/**
 * A message whose origin reaches less of the screen than the running turn waits as the next turn
 * instead of using what that turn was given: a steer queues, a promotion is refused, an answer
 * is delivered as the next turn (steeringAllowed in ComputerUseOrigin).
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
import {
  type ComputerUseOrigin,
  computerUseOrigin,
  gateUnattendedSteering,
  projectionOriginReads,
  senderOrigin,
  steeringAllowed,
} from "./ComputerUseOrigin.ts";
import type * as CuaDriver from "./CuaDriver.ts";

const unattendedRemote: ComputerUseOrigin = { _tag: "unattended", reason: "launched_remotely" };
const unattendedSent: ComputerUseOrigin = { _tag: "unattended", reason: "sent_by_unattended" };

type PromoteCommand = Extract<
  OrchestrationV2Command,
  { readonly type: "queued-message.promote-to-steer" }
>;

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

  const enabled = Option.isNone(deps.cuaDriver)
    ? Effect.succeed(false)
    : deps.cuaDriver.value.enabled;

  /**
   * Holds an agent's or the server's promotion to the same rule as a steer, weighing the queued
   * turn's own origin (the sender as it was when it wrote). A person's own promotion is their
   * decision and does not come here.
   */
  const admitPromotion = Effect.fn("ComputerUseSteering.admitPromotion")(function* (
    command: PromoteCommand,
  ) {
    if (!(yield* enabled)) return command;
    const message = yield* computerUseOrigin(reads, {
      threadId: command.threadId,
      runId: command.queuedRunId,
    });
    if (
      yield* steeringAllowed(reads, {
        threadId: command.threadId,
        message,
        targetRunId: command.targetRunId,
      })
    )
      return command;
    return yield* refuse(
      command,
      "This message comes from work with less of the screen than the running turn, so it stays queued and runs as its own turn.",
    );
  });

  /**
   * Holds an agent's answer to the same rule as a steer; other commands pass unchanged. The
   * answer names the one running turn it may join, which the orchestrator checks again under its
   * lock, so a turn that starts after this check never takes it.
   */
  const admit = Effect.fn("ComputerUseSteering.admit")(function* (
    command: OrchestrationV2ServerCommand,
  ) {
    if (command.type !== "runtime-request.respond" || command.respondedBy?.type !== "agent")
      return command;
    const responder = command.respondedBy;
    const records = yield* deps.orchestrator
      .getThreadRecords(command.threadId, ["runs"])
      .pipe(Effect.mapError((cause) => refuse(command, String(cause))));
    const running = records.runs.find((run) => run.status === "running");
    if (running === undefined) return command;
    const approved = { ...command, answerSteersRunId: running.id };
    if (!(yield* enabled)) return approved;
    // Another computer's agent counts as remote work; a local one as the run it sends from.
    const sender =
      responder.environmentId === null
        ? yield* senderOrigin(reads, responder.threadId)
        : unattendedRemote;
    const message =
      sender._tag === "interactive" ||
      (sender._tag === "unattended" && sender.reason === "launched_remotely")
        ? sender
        : unattendedSent;
    return (yield* steeringAllowed(reads, {
      threadId: command.threadId,
      message,
      targetRunId: running.id,
    }))
      ? approved
      : command;
  });

  return { steeringMode, admit, admitPromotion };
};
