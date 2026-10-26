import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import type * as ComputerUseAgentConnections from "./ComputerUseAgentConnections.ts";

export const statusChanges = (
  receiver: Option.Option<DesktopTelemetryReceiver.DesktopTelemetryReceiver["Service"]>,
  connections: Option.Option<
    ComputerUseAgentConnections.ComputerUseAgentConnections["Service"]
  > = Option.none(),
) =>
  Option.isNone(receiver) && Option.isNone(connections)
    ? Stream.succeed({ revision: 0 })
    : Stream.unwrap(
        Effect.gen(function* () {
          const changes = yield* Queue.unbounded<void>();
          // Agent connections failing on this host, or working again, change the status too.
          if (Option.isSome(connections))
            yield* Stream.fromSubscription(yield* connections.value.changes).pipe(
              Stream.runForEach(() => Queue.offer(changes, undefined)),
              Effect.forkScoped({ startImmediately: true }),
            );
          if (Option.isNone(receiver)) return statusRevisions(changes);
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
          return statusRevisions(changes);
        }),
      );

const statusRevisions = (changes: Queue.Queue<void>) =>
  Stream.fromQueue(changes).pipe(
    Stream.scan(
      () => ({ revision: 0 }),
      ({ revision }) => ({ revision: revision + 1 }),
    ),
  );
