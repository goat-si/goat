// @effect-diagnostics nodeBuiltinImport:off -- The channel is a Node socket the lease proxy's child process inherits as fd 3.
import type * as NodeStream from "node:stream";

import type { ComputerUseOverlayCommand } from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/** How long a command may take to reach the screen before the proxy forwards the call anyway. */
export const OVERLAY_ACK_TIMEOUT_MS = 250;

/**
 * The proxy's end of the overlay channel: fd 3 of a macOS helper started with --mcp (#1214).
 * The driver inherits only stdio, so it never sees this channel. Each command is one line,
 * {seq, command}. The helper answers {ack: seq} once the change is on screen, or off it for a
 * hide. That answer is what lets the proxy forward a capture only after the overlay is gone.
 *
 * Losing the overlay never stops computer use. A closed channel or a late ack makes send
 * return after the timeout.
 */
export function overlayChannel(socket: NodeStream.Duplex) {
  let seq = 0;
  let buffered = "";
  const waiting = new Map<number, () => void>();
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      try {
        const ack = (JSON.parse(line) as { ack?: unknown }).ack;
        if (typeof ack === "number") waiting.get(ack)?.();
      } catch {
        // Not an ack; the helper writes nothing else here.
      }
    }
  });
  const release = () => {
    for (const done of waiting.values()) done();
  };
  socket.on("close", release);
  socket.on("error", release);

  return (command: ComputerUseOverlayCommand) =>
    Effect.callback<void>((resume) => {
      if (socket.destroyed || !socket.writable) return resume(Effect.void);
      const id = ++seq;
      waiting.set(id, () => {
        waiting.delete(id);
        resume(Effect.void);
      });
      socket.write(JSON.stringify({ seq: id, command }) + "\n");
      return Effect.sync(() => void waiting.delete(id));
    }).pipe(Effect.timeoutOption(Duration.millis(OVERLAY_ACK_TIMEOUT_MS)), Effect.asVoid);
}
