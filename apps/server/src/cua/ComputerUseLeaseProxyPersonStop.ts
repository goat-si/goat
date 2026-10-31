import type { ComputerUseLeaseUpdate, ComputerUsePauseReason } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { driverScreenLocked } from "./ComputerUseDriverOutcome.ts";
import {
  LEASE_END_MESSAGES,
  PAUSE_MESSAGES,
  type Interruption,
} from "./ComputerUseLeaseMessages.ts";
import { refusal, type JsonRpcId } from "./ComputerUseLeaseResponses.ts";

export function makePersonStopFence() {
  let reason: "stopped_by_person" | "screen_locked" | undefined;
  let lockConfirmed = false;
  return {
    pending: () => reason !== undefined,
    terminal: () => reason,
    beginStop: () => {
      if (reason !== undefined) return false;
      reason = "stopped_by_person";
      return true;
    },
    beginLock: (message: unknown) => {
      if (reason !== undefined || !driverScreenLocked(message)) return false;
      reason = "screen_locked";
      return true;
    },
    confirm: (update: ComputerUseLeaseUpdate | undefined) => {
      if (update?.state === "paused" && update.reason === "screen_locked") {
        reason ??= "screen_locked";
        lockConfirmed = true;
      }
      if (
        update?.state === "ended" &&
        (update.reason === "stopped" || update.reason === "stopped_all")
      )
        reason ??= "stopped_by_person";
    },
    activate: (
      update: Extract<ComputerUseLeaseUpdate, { readonly state: "active" }>,
      paused: ComputerUsePauseReason | undefined,
      interruptionsSeen: number | undefined,
    ) => {
      if (reason === "screen_locked" && !lockConfirmed) {
        const sawLock =
          update.interruptions?.last === "screen_locked" &&
          update.interruptions.count > (interruptionsSeen ?? 0);
        if (!sawLock) return false;
        lockConfirmed = true;
      }
      if (paused === "screen_locked") {
        if (reason === "screen_locked") reason = undefined;
        lockConfirmed = false;
      }
      return true;
    },
    refusal: (id: JsonRpcId, method: string | undefined) =>
      reason === "screen_locked"
        ? refusal(id, method, "screen_locked", PAUSE_MESSAGES.screen_locked)
        : reason === "stopped_by_person"
          ? refusal(id, method, "stopped", LEASE_END_MESSAGES.stopped)
          : undefined,
  };
}

export const isTerminalStop = (finished: string | undefined, paused: string | undefined) =>
  finished === "stopped" || finished === "stopped_all" || paused === "screen_locked";

export const terminalForInterruption = (
  cause: Interruption,
  terminal: "stopped_by_person" | "screen_locked" | undefined,
): { readonly terminal?: "stopped_by_person" | "screen_locked" } =>
  terminal !== undefined
    ? { terminal }
    : cause._tag === "end" && (cause.reason === "stopped" || cause.reason === "stopped_all")
      ? { terminal: "stopped_by_person" }
      : cause._tag === "pause" && cause.reason === "screen_locked"
        ? { terminal: "screen_locked" }
        : {};

export const latchedInterruption = (
  cause: Interruption,
  terminal: "stopped_by_person" | "screen_locked" | undefined,
): Interruption =>
  (terminal === "stopped_by_person" &&
    cause._tag === "end" &&
    (cause.reason === "stopped" || cause.reason === "stopped_all")) ||
  (terminal === "screen_locked" && cause._tag === "pause" && cause.reason === "screen_locked")
    ? cause
    : terminal === "stopped_by_person"
      ? { _tag: "end", reason: "stopped" }
      : terminal === "screen_locked"
        ? { _tag: "pause", reason: "screen_locked" }
        : cause;

export const forwardPersonStop = Effect.fn("ComputerUseLeaseProxy.forwardPersonStop")(
  function* (input: {
    readonly events: Stream.Stream<void> | undefined;
    readonly report: (() => Effect.Effect<boolean>) | undefined;
    readonly active: () => boolean;
    readonly current: () => boolean;
    readonly fence: ReturnType<typeof makePersonStopFence>;
    readonly stop: Effect.Effect<void>;
    readonly scope: Scope.Scope;
    readonly driverScope: Scope.Scope;
  }) {
    if (input.events === undefined || input.report === undefined) return;
    const report = input.report;
    yield* input.events.pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          if (!input.active() || !input.current() || !input.fence.beginStop()) return;
          yield* input.stop.pipe(Effect.forkIn(input.scope));
          yield* Effect.gen(function* () {
            const accepted = yield* report();
            if (!accepted)
              yield* Effect.logWarning(
                "Could not report Escape stop to GOAT; stopping the local driver.",
              );
          }).pipe(Effect.forkIn(input.scope));
        }),
      ),
      Effect.forkIn(input.driverScope),
    );
  },
);
