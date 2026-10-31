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
  let personStop = false;
  let screenLock = false;
  let lockConfirmed = false;
  return {
    pending: () => personStop || screenLock,
    beginStop: () => {
      if (personStop) return false;
      personStop = true;
      return true;
    },
    beginLock: (message: unknown) => {
      if (screenLock || !driverScreenLocked(message)) return false;
      screenLock = true;
      return true;
    },
    confirm: (update: ComputerUseLeaseUpdate | undefined) => {
      if (update?.state === "paused" && update.reason === "screen_locked") lockConfirmed = true;
    },
    activate: (
      update: Extract<ComputerUseLeaseUpdate, { readonly state: "active" }>,
      paused: ComputerUsePauseReason | undefined,
      interruptionsSeen: number | undefined,
    ) => {
      if (screenLock && !lockConfirmed) {
        const sawLock =
          update.interruptions?.last === "screen_locked" &&
          update.interruptions.count > (interruptionsSeen ?? 0);
        if (!sawLock) return false;
        lockConfirmed = true;
      }
      if (paused === "screen_locked") {
        screenLock = false;
        lockConfirmed = false;
      }
      return true;
    },
    refusal: (id: JsonRpcId, method: string | undefined) =>
      screenLock
        ? refusal(id, method, "screen_locked", PAUSE_MESSAGES.screen_locked)
        : personStop
          ? refusal(id, method, "stopped", LEASE_END_MESSAGES.stopped)
          : undefined,
  };
}

export const isTerminalStop = (finished: string | undefined, paused: string | undefined) =>
  finished === "stopped" || finished === "stopped_all" || paused === "screen_locked";

export const terminalForInterruption = (
  cause: Interruption,
): { readonly terminal?: "stopped_by_person" | "screen_locked" } =>
  cause._tag === "end" && (cause.reason === "stopped" || cause.reason === "stopped_all")
    ? { terminal: "stopped_by_person" }
    : cause._tag === "pause" && cause.reason === "screen_locked"
      ? { terminal: "screen_locked" }
      : {};

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
