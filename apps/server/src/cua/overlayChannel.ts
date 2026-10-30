// @effect-diagnostics nodeBuiltinImport:off -- The channel is a Node socket the lease proxy's child process inherits as fd 3.
import type * as NodeStream from "node:stream";

import { ComputerUseHumanInputSource, ComputerUseOverlayCommand } from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeAck = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ ack: Schema.Number })),
);
const HelperHumanInput = Schema.Struct({
  source: ComputerUseHumanInputSource,
  ageMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});
/** The helper saw a keyboard or pointer event `ageMs` before it wrote this; nothing more. */
export type HelperHumanInput = typeof HelperHumanInput.Type;
const decodeHumanInput = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ humanInput: HelperHumanInput })),
);
const decodePersonStop = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ personStop: Schema.Literal("person_esc") })),
);
const encodeLine = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ seq: Schema.Number, command: ComputerUseOverlayCommand })),
);

/** How long a command may take to reach the screen. A capture needs an acknowledged hide. */
export const OVERLAY_ACK_TIMEOUT_MS = 250;
export type OverlayAckOutcome = "applied" | "unavailable" | "timed_out";

/**
 * The proxy's end of the overlay channel: fd 3 of a macOS helper started with --mcp (#1214).
 * The driver inherits only stdio, so it never sees this channel. Each command is one line,
 * {seq, command}. The helper answers {ack: seq} once the change is on screen, or off it for a
 * hide. That answer is what lets the proxy forward a capture only after the overlay is gone.
 *
 * A closed channel or a late ack never counts as an applied hide. The proxy can still forward
 * non-capture calls; a capture checks captureHideConfirmed before forwarding.
 *
 * The helper also writes {humanInput: {source, ageMs}} lines on it while it runs (#1235): every
 * new keyboard or pointer event the system had, the agent's own included, for the proxy to sort.
 */
export function overlayChannel(
  socket: NodeStream.Duplex,
  onHumanInput: (input: HelperHumanInput) => void = () => undefined,
  onPersonStop: () => void = () => undefined,
) {
  let seq = 0;
  let buffered = "";
  const waiting = new Map<number, (outcome: OverlayAckOutcome) => void>();
  let mayBeVisible = false;
  let lastHideOutcome: OverlayAckOutcome = "unavailable";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      const ack = decodeAck(line);
      if (Option.isSome(ack)) waiting.get(ack.value.ack)?.("applied");
      const input = decodeHumanInput(line);
      if (Option.isSome(input)) onHumanInput(input.value.humanInput);
      if (Option.isSome(decodePersonStop(line))) onPersonStop();
    }
  });
  const release = () => {
    for (const done of waiting.values()) done("unavailable");
  };
  socket.on("close", release);
  socket.on("error", release);

  const send = (command: ComputerUseOverlayCommand) =>
    Effect.callback<OverlayAckOutcome>((resume) => {
      if (socket.destroyed || !socket.writable) return resume(Effect.succeed("unavailable"));
      const id = ++seq;
      if (command.op === "show") {
        mayBeVisible = true;
        lastHideOutcome = "unavailable";
      }
      waiting.set(id, (outcome) => {
        waiting.delete(id);
        resume(Effect.succeed(outcome));
      });
      socket.write(encodeLine({ seq: id, command }) + "\n");
      return Effect.sync(() => void waiting.delete(id));
    }).pipe(
      Effect.timeoutOption(Duration.millis(OVERLAY_ACK_TIMEOUT_MS)),
      Effect.map((answer) => Option.getOrElse(answer, () => "timed_out" as const)),
      Effect.tap((outcome) =>
        Effect.sync(() => {
          if (command.op !== "hide") return;
          lastHideOutcome = outcome;
          if (outcome === "applied") mayBeVisible = false;
        }),
      ),
      Effect.asVoid,
    );
  /**
   * Writes a command and returns without waiting for its acknowledgement. A show needs none: the
   * helper applies commands in order, so a later hide still lands after it, and a capture checks
   * its own hide. The call's answer no longer waits for the cursor to reach the screen.
   */
  const post = (command: ComputerUseOverlayCommand) =>
    Effect.sync(() => {
      if (socket.destroyed || !socket.writable) return;
      if (command.op === "show") {
        mayBeVisible = true;
        lastHideOutcome = "unavailable";
      }
      socket.write(encodeLine({ seq: ++seq, command }) + "\n");
    });
  return Object.assign(send, {
    post,
    captureHideConfirmed: () => !mayBeVisible || lastHideOutcome === "applied",
    lastHideOutcome: () => lastHideOutcome,
  });
}
