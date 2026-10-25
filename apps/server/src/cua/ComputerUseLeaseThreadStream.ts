import type { ComputerUseLeaseThreadUpdate, ThreadId } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";

export const threadLeaseUpdates = (input: {
  readonly threadId: ThreadId;
  readonly token: string;
}) =>
  Stream.callback<
    ComputerUseLeaseThreadUpdate,
    never,
    | ComputerUseLeases.ComputerUseLeases
    | ServerSettings.ServerSettingsService
    | McpSessionRegistry.McpSessionRegistry
  >(
    Effect.fn("ComputerUseLeaseThreadStream.follow")(function* (queue) {
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const settings = yield* ServerSettings.ServerSettingsService;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const wake = yield* Queue.sliding<void>(1);
      // Acquire every subscription before reading authority, including while no control exists.
      const controls = yield* leases.subscribe;
      const credentials = yield* registry.subscribeChanges;
      const settingsChanges = yield* settings.subscribeChanges;
      for (const subscription of [controls, credentials]) {
        yield* PubSub.take(subscription).pipe(
          Effect.andThen(Queue.offer(wake, undefined)),
          Effect.forever,
          Effect.forkScoped,
        );
      }
      yield* settingsChanges.pipe(
        Stream.runForEach(() => Queue.offer(wake, undefined)),
        Effect.forkScoped,
      );
      let previous: string | undefined;
      let lastEnded: string | undefined;
      let waiting = false;
      for (;;) {
        if ((yield* registry.resolve(input.token))?.thread.threadId !== input.threadId) {
          yield* Queue.offer(queue, { state: "ended", reason: "unauthorized" });
          return yield* Queue.end(queue);
        }
        const enabled = yield* settings.getSettings.pipe(
          Effect.map((value) => value.enableCua),
          Effect.orElseSucceed(() => false),
        );
        if (!enabled) {
          yield* Queue.offer(queue, { state: "ended", reason: "disabled" });
          return yield* Queue.end(queue);
        }
        const current = Option.getOrUndefined(yield* leases.currentControl(input.threadId));
        const state =
          current === undefined
            ? undefined
            : yield* leases.controlState(input.threadId, current.controlId).pipe(Effect.option);
        if (state !== undefined && Option.isNone(state)) {
          yield* Queue.offer(queue, { state: "ended", reason: "revoked" });
          return yield* Queue.end(queue);
        }
        // controlState can suspend on grant reads. A revocation during that read must win.
        if ((yield* registry.resolve(input.token))?.thread.threadId !== input.threadId) {
          yield* Queue.offer(queue, { state: "ended", reason: "unauthorized" });
          return yield* Queue.end(queue);
        }
        const latest = Option.getOrUndefined(yield* leases.currentControl(input.threadId));
        if (current?.controlId !== latest?.controlId || current?.ended !== latest?.ended) continue;
        if (previous !== undefined && previous !== current?.controlId) {
          yield* Queue.offer(queue, {
            state: "control-ended",
            controlId: previous,
            reason: current === undefined ? "revoked" : "replaced",
          });
          lastEnded = previous;
          previous = undefined;
        }
        const value = state === undefined ? undefined : Option.getOrUndefined(state);
        if (current === undefined || value === undefined || value._tag === "ended") {
          if (current !== undefined && value?._tag === "ended" && current.controlId !== lastEnded) {
            yield* Queue.offer(queue, {
              state: "control-ended",
              controlId: current.controlId,
              reason: value.reason,
            });
            lastEnded = current.controlId;
          }
          previous = undefined;
          if (!waiting) yield* Queue.offer(queue, { state: "waiting" });
          waiting = true;
          yield* Queue.take(wake);
          continue;
        }
        previous = current.controlId;
        waiting = false;
        const identity = {
          controlId: current.controlId,
          expiresAt: DateTime.formatIso(current.expiresAt),
        };
        yield* Queue.offer(
          queue,
          value._tag === "paused"
            ? { state: "paused", ...identity, reason: value.reason }
            : value.idle === true
              ? { state: "idle", ...identity }
              : {
                  state: "active",
                  ...identity,
                  ...(value.apps === undefined ? {} : { apps: value.apps }),
                  ...(value.idleEpoch === undefined ? {} : { idleEpoch: value.idleEpoch }),
                  ...(value.foreground === undefined ? {} : { foreground: value.foreground }),
                  ...(value.interruptions.count === 0
                    ? {}
                    : { interruptions: value.interruptions }),
                  ...(value.shared === true ? { shared: true } : {}),
                },
        );
        const deadline = DateTime.toEpochMillis(current.expiresAt);
        const wakeAt = value._tag === "active" ? Math.min(deadline, value.wakeAt) : deadline;
        yield* Effect.raceFirst(
          Queue.take(wake),
          Effect.sleep(Math.max(0, wakeAt - (yield* Clock.currentTimeMillis))),
        );
      }
    }),
  );
