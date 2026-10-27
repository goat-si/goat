/**
 * Keeps the proxy's lease stream open across drops, like ICE "disconnected" before "failed": a
 * drop is reconnecting, a long outage is transport_lost, and only a server end stops for good.
 *
 * @module ComputerUseLeaseStreamFollower
 */
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/** Local transport state the thread proxy hears beside the server's own updates. */
export type LeaseTransportUpdate =
  | { readonly state: "reconnecting" }
  | { readonly state: "transport_lost" };

export type LeaseStreamAttempt =
  | {
      readonly _tag: "open";
      readonly lines: Stream.Stream<string, Error>;
      /** The server's heartbeat interval; absent from servers that send none. */
      readonly heartbeatMs?: number | undefined;
    }
  | { readonly _tag: "retry" };

/** The server sends a heartbeat this often (ComputerUseLeaseRoute.ts). */
export const LEASE_HEARTBEAT_MS = 15_000;
export const LEASE_HEARTBEAT_HEADER = "x-goat-lease-heartbeat-ms";
/** Three missed heartbeats mean the connection is gone even if the socket says otherwise. */
const MISSED_HEARTBEATS = 3;
const CONNECT_TIMEOUT_MS = 10_000;
const FIRST_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5_000;
/** After transport_lost nothing is held for the agent, so retries slow down. */
const LOST_BACKOFF_MS = 30_000;
const RECONNECT_WINDOW_MS = 120_000;
/** A connection must stay up this long before backoff starts over, or a flapping server races. */
const HEALTHY_MS = 30_000;

type Read = { readonly _tag: "line"; readonly line: string } | { readonly _tag: "closed" };

export const followLeaseStream = Effect.fn("ComputerUseLeaseStreamFollower.follow")(
  function* (input: {
    /** Opens one connection; closing its scope aborts the request. */
    readonly connect: Effect.Effect<LeaseStreamAttempt, never, Scope.Scope>;
    /** "end" after a terminal server update: the stream is not reopened. */
    readonly onLine: (line: string) => Effect.Effect<"continue" | "end">;
    readonly onTransport: (update: LeaseTransportUpdate) => Effect.Effect<void>;
    readonly random?: () => number;
  }) {
    const random = input.random ?? Math.random;
    let failures = 0;
    let lost = false;
    let openedAt: number | undefined;
    let outage: Fiber.Fiber<void> | undefined;
    // The server answered: the outage is over, though backoff resets only once the link holds.
    const recovered = Effect.gen(function* () {
      openedAt ??= yield* Clock.currentTimeMillis;
      const timer = outage;
      if (timer === undefined) return;
      outage = undefined;
      lost = false;
      yield* Fiber.interrupt(timer);
    });
    const dropped = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (openedAt !== undefined && now - openedAt >= HEALTHY_MS) failures = 0;
      openedAt = undefined;
      if (outage === undefined) {
        yield* input.onTransport({ state: "reconnecting" });
        outage = yield* Effect.sleep(RECONNECT_WINDOW_MS).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              lost = true;
              return input.onTransport({ state: "transport_lost" });
            }),
          ),
          Effect.forkChild,
        );
      }
      // Full jitter: proxies of one server that dropped together do not return together.
      const cap = lost
        ? LOST_BACKOFF_MS
        : Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** failures);
      failures = Math.min(failures + 1, 16);
      const delay = Math.floor(random() * cap);
      if (delay > 0) yield* Effect.sleep(delay);
    });

    const attempt = Effect.gen(function* () {
      const opened = yield* input.connect.pipe(Effect.timeoutOption(CONNECT_TIMEOUT_MS));
      if (Option.isNone(opened) || opened.value._tag === "retry") return "dropped" as const;
      const connection = opened.value;
      const lines = yield* Queue.unbounded<string, Cause.Done>();
      yield* connection.lines.pipe(
        Stream.runForEach((line) => Queue.offer(lines, line)),
        Effect.ignoreCause,
        Effect.ensuring(Queue.end(lines)),
        Effect.forkScoped,
      );
      const take: Effect.Effect<Read> = Queue.take(lines).pipe(
        Effect.map((line): Read => ({ _tag: "line", line })),
        Effect.catchCause(() => Effect.succeed<Read>({ _tag: "closed" })),
      );
      // Without a server heartbeat a quiet stream is normal; only the socket can say it is gone.
      const idle =
        connection.heartbeatMs === undefined || connection.heartbeatMs <= 0
          ? undefined
          : connection.heartbeatMs * MISSED_HEARTBEATS;
      for (;;) {
        const read =
          idle === undefined
            ? yield* take
            : Option.getOrElse(yield* take.pipe(Effect.timeoutOption(idle)), (): Read => ({
                _tag: "closed",
              }));
        if (read._tag === "closed") return "dropped" as const;
        yield* recovered;
        if ((yield* input.onLine(read.line)) === "end") return "ended" as const;
      }
    }).pipe(Effect.scoped);

    for (;;) {
      if ((yield* attempt) === "ended") return yield* recovered;
      yield* dropped;
    }
  },
);
