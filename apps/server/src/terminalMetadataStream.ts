import type { TerminalMetadataStreamEvent, TerminalSummary } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export const terminalMetadataStream = <R>(
  subscribe: (
    listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
  ) => Effect.Effect<() => void, never, R>,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const changes = yield* Queue.sliding<void>(1);
      const terminals = new Map<string, TerminalSummary>();
      const key = (threadId: string, terminalId: string) => JSON.stringify([threadId, terminalId]);
      yield* Effect.acquireRelease(
        subscribe((event) =>
          Effect.sync(() => {
            if (event.type === "snapshot") {
              terminals.clear();
              for (const terminal of event.terminals) {
                terminals.set(key(terminal.threadId, terminal.terminalId), terminal);
              }
            } else if (event.type === "upsert") {
              terminals.set(
                key(event.terminal.threadId, event.terminal.terminalId),
                event.terminal,
              );
            } else {
              terminals.delete(key(event.threadId, event.terminalId));
            }
          }).pipe(Effect.andThen(Queue.offer(changes, undefined)), Effect.asVoid),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      return Stream.fromQueue(changes).pipe(
        Stream.map(() => ({
          type: "snapshot" as const,
          terminals: Array.from(terminals.values()),
        })),
      );
    }),
  );
