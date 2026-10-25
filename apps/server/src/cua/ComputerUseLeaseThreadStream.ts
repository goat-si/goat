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
      // inspect, unlike resolve, never renews the credential: watching is not using it.
      const authorized = Effect.map(registry.inspect(input.token), (credential) =>
        credential?.threadId === input.threadId ? credential : undefined,
      );
      // Credential expiry publishes nothing, so a quiet stream wakes for it on its own.
      const until = (at: number) =>
        Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Effect.sleep(Math.max(0, at - now))));
      for (;;) {
        const credential = yield* authorized;
        if (credential === undefined) {
          yield* Queue.offer(queue, { state: "ended", reason: "unauthorized" });
          return yield* Queue.end(queue);
        }
        const enabled = yield* settings.getSettings.pipe(
          Effect.map((value) => value.enableCua),
          Effect.orElseSucceed(() => false),
        );
        const current = Option.getOrUndefined(yield* leases.currentControl(input.threadId));
        const value = !enabled
          ? { _tag: "ended" as const, reason: "disabled" as const }
          : current === undefined
            ? undefined
            : yield* leases.controlState(input.threadId, current.controlId).pipe(
                // A failed authority read fences this control; a later control can recover.
                Effect.orElseSucceed(() => ({
                  _tag: "ended" as const,
                  reason: "revoked" as const,
                })),
              );
        // controlState can suspend on grant reads. A revocation during that read must win.
        if ((yield* authorized) === undefined) {
          yield* Queue.offer(queue, { state: "ended", reason: "unauthorized" });
          return yield* Queue.end(queue);
        }
        const latest = Option.getOrUndefined(yield* leases.currentControl(input.threadId));
        if (current?.controlId !== latest?.controlId || current?.ended !== latest?.ended) continue;
        if (previous !== undefined && previous !== current?.controlId) {
          yield* Queue.offer(queue, {
            state: "control-ended",
            controlId: previous,
            reason: !enabled ? "disabled" : current === undefined ? "revoked" : "replaced",
          });
          lastEnded = previous;
          previous = undefined;
        }
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
          yield* Effect.raceFirst(Queue.take(wake), until(credential.recheckAt));
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
        const wakeAt = Math.min(
          value._tag === "active" ? Math.min(deadline, value.wakeAt) : deadline,
          credential.recheckAt,
        );
        yield* Effect.raceFirst(Queue.take(wake), until(wakeAt));
      }
    }),
  );
