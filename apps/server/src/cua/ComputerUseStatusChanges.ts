import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

export const statusChanges = (
  receiver: Option.Option<DesktopTelemetryReceiver.DesktopTelemetryReceiver["Service"]>,
) =>
  Option.isNone(receiver)
    ? Stream.succeed({ revision: 0 })
    : Stream.unwrap(
        Effect.gen(function* () {
          const changes = yield* Queue.unbounded<void>();
          // Arm both subscriptions before the initial tick lets a client query this host.
          yield* receiver.value.cuaSafety.pipe(
            Stream.filter((report) => report.type === "cuaReadiness"),
            Stream.runForEach(() => Queue.offer(changes, undefined)),
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* receiver.value.cuaReports.pipe(
            Stream.runForEach(() => Queue.offer(changes, undefined)),
            Effect.forkScoped({ startImmediately: true }),
          );
          return Stream.fromQueue(changes).pipe(
            Stream.scan(
              () => ({ revision: 0 }),
              ({ revision }) => ({ revision: revision + 1 }),
            ),
          );
        }),
      );
