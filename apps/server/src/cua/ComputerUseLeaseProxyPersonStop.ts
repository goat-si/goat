import type { ComputerUseLeaseUpdate, ComputerUsePauseReason } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import { driverScreenLocked } from "./ComputerUseDriverOutcome.ts";
import {
  LEASE_END_MESSAGES,
  PAUSE_MESSAGES,
  isReadOnlyCall,
  type Interruption,
} from "./ComputerUseLeaseMessages.ts";
import { terminalReplacement, refusal, type JsonRpcId } from "./ComputerUseLeaseResponses.ts";
import type { OutstandingCall, ReplySink } from "./ComputerUseLeaseProxyOptions.ts";
import type { Envelope } from "./ComputerUseLeaseProtocol.ts";
import {
  mergeTerminal,
  terminalErrorState,
  terminalReason,
  terminalReplyState,
  type ComputerUseTerminalReason,
  type ComputerUseTerminalState,
} from "./ComputerUseTerminal.ts";

const decodeTerminal = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.optionalKey(Schema.Json),
      error: Schema.optionalKey(Schema.Json),
    }),
  ),
);

export const finalTerminalLine = (
  line: string,
  status: import("@goat/contracts").ComputerUsePrimitiveReply["status"] | undefined,
  message: Envelope | undefined,
  terminal: ComputerUseTerminalState,
): {
  line: string;
  status: import("@goat/contracts").ComputerUsePrimitiveReply["status"] | undefined;
} => {
  if (message?.method !== "tools/call" || message.id == null) return { line, status };
  const already = decodeTerminal(line);
  const reply = terminalReplyState(
    already._tag === "Some" ? already.value.result : undefined,
    status,
  );
  const merged = mergeTerminal(
    mergeTerminal(terminal, reply),
    terminalErrorState(already._tag === "Some" ? already.value.error : undefined),
  );
  const reason = merged.reason;
  if (
    reason === undefined ||
    (reply.wireReason === reason &&
      reply.terminalSafety &&
      (!merged.possibleCommit || reply.possibleCommit))
  )
    return { line, status };
  const tool = typeof message.params?.name === "string" ? message.params.name : undefined;
  return {
    line: terminalReplacement(
      message.id,
      tool,
      message.params?.arguments,
      { ...merged, reason },
      merged.possibleCommit,
    ),
    status: merged.possibleCommit ? "unknown_outcome" : "not_started",
  };
};

export const terminalSink = (
  sink: ReplySink,
  message: Envelope,
  terminal: (() => ComputerUseTerminalReason | undefined) & { readonly release?: () => void },
  dispatched: () => boolean,
): ReplySink => ({
  terminal,
  ...(terminal.release === undefined ? {} : { release: terminal.release }),
  answer: (line, status, context) =>
    Effect.suspend(() => {
      const finalContext = {
        ...context,
        request: message,
        terminalState: () =>
          mergeTerminal(context?.terminalState?.() ?? {}, {
            reason: terminalReason(terminal()),
            possibleCommit:
              dispatched() &&
              !isReadOnlyCall(
                typeof message.params?.name === "string" ? message.params.name : undefined,
                message.params?.arguments,
              ),
          }),
      };
      const result = finalTerminalLine(line, status, message, finalContext.terminalState());
      return sink.answer(result.line, result.status, finalContext);
    }).pipe(Effect.ensuring(Effect.sync(() => terminal.release?.()))),
});

export function makePersonStopFence() {
  let reason: "stopped_by_person" | "screen_locked" | undefined;
  let epoch: { reason?: "stopped_by_person" | "screen_locked" | undefined } = {};
  // Stop and lock update every epoch captured by an unfinished call of this control.
  const capturedEpochs = new Map<typeof epoch, number>();
  let lockConfirmed = false;
  const latch = (value: "stopped_by_person" | "screen_locked") => {
    reason = mergeTerminal({ reason }, { reason: value }).reason;
    epoch.reason = mergeTerminal({ reason: epoch.reason }, { reason: value }).reason;
    for (const entry of capturedEpochs.keys())
      entry.reason = mergeTerminal({ reason: entry.reason }, { reason: value }).reason;
  };
  const capture = (message?: Envelope, inherited?: ReplySink["terminal"]) => {
    if (inherited !== undefined) return inherited;
    if (message !== undefined && (message.method !== "tools/call" || message.id == null))
      return () => reason;
    const captured = epoch;
    const registry = capturedEpochs;
    registry.set(captured, (registry.get(captured) ?? 0) + 1);
    let released = false;
    return Object.assign(() => captured.reason, {
      release: () => {
        if (released) return;
        released = true;
        const count = registry.get(captured) ?? 0;
        if (count > 1) registry.set(captured, count - 1);
        else registry.delete(captured);
      },
    });
  };
  return {
    pending: () => reason !== undefined,
    terminal: () => reason,
    capture,
    sink: (raw: ReplySink, message: Envelope, dispatched: () => boolean) =>
      terminalSink(raw, message, capture(message, raw.terminal), dispatched),
    cancel: (request: OutstandingCall | undefined) => {
      if (request !== undefined) {
        request.cancelled = true;
        request.sink.release?.();
      }
    },
    beginStop: () => {
      if (reason === "stopped_by_person") return false;
      latch("stopped_by_person");
      return true;
    },
    beginLock: (message: unknown) => {
      if (reason !== undefined || !driverScreenLocked(message)) return false;
      latch("screen_locked");
      return true;
    },
    confirm: (update: ComputerUseLeaseUpdate | undefined) => {
      if (update?.state === "paused" && update.reason === "screen_locked") {
        latch("screen_locked");
        lockConfirmed = true;
      }
      if (
        update?.state === "ended" &&
        (update.reason === "stopped" || update.reason === "stopped_all")
      )
        latch("stopped_by_person");
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
        if (reason === "screen_locked") {
          reason = undefined;
          epoch = {};
        }
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

export const terminalForInterruption = (
  cause: Interruption,
  terminal: "stopped_by_person" | "screen_locked" | undefined,
): { readonly terminal?: "stopped_by_person" | "screen_locked" } => {
  const reason = mergeTerminal(
    { reason: terminal },
    {
      reason:
        cause._tag === "end" && (cause.reason === "stopped" || cause.reason === "stopped_all")
          ? "stopped_by_person"
          : cause._tag === "pause" && cause.reason === "screen_locked"
            ? "screen_locked"
            : undefined,
    },
  ).reason;
  return reason === undefined ? {} : { terminal: reason };
};

export const latchedInterruption = (
  cause: Interruption,
  terminal: "stopped_by_person" | "screen_locked" | undefined,
): Interruption => {
  terminal = terminalForInterruption(cause, terminal).terminal;
  return (terminal === "stopped_by_person" &&
    cause._tag === "end" &&
    (cause.reason === "stopped" || cause.reason === "stopped_all")) ||
    (terminal === "screen_locked" && cause._tag === "pause" && cause.reason === "screen_locked")
    ? cause
    : terminal === "stopped_by_person"
      ? { _tag: "end", reason: "stopped" }
      : terminal === "screen_locked"
        ? { _tag: "pause", reason: "screen_locked" }
        : cause;
};

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
