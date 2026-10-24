// @effect-diagnostics preferSchemaOverJson:off -- raw JSON-RPC lines are the fixture's public boundary.
import {
  type ComputerUseLeaseUpdate,
  type ComputerUseOverlayCommand,
  type ComputerUseCallReservation,
  type ComputerUseCallAdmission,
  TurnItemId,
} from "@goat/contracts";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { NamedWindow } from "./x11WindowPlacement.ts";
import { runLeaseProxy } from "./ComputerUseLeaseProxy.ts";

export const CONTROL = "control:one";
export const call = (id: number | string, name: string, args: object = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
export const active = (
  expiresAt = "1970-01-01T00:30:00.000Z",
  apps?: ReadonlyArray<string>,
): Extract<ComputerUseLeaseUpdate, { state: "active" }> => ({
  state: "active",
  controlId: CONTROL,
  expiresAt,
  ...(apps === undefined ? {} : { apps }),
});

export const foregroundActive = (expiresAt = "1970-01-01T00:30:00.000Z") => ({
  ...active(expiresAt),
  foreground: [
    {
      handoffId: TurnItemId.make("handoff:foreground"),
      purpose: "Check the build status",
      target: "desktop" as const,
      expiresAtMillis: DateTime.toEpochMillis(DateTime.makeUnsafe(expiresAt)),
    },
  ],
});

interface FakeDriver {
  readonly toDriver: Queue.Queue<string>;
  readonly fromDriver: Queue.Queue<string, Cause.Done>;
  readonly killed: Deferred.Deferred<void>;
}

/** A proxy over in-memory stdio, lease stream and drivers, on the TestClock (epoch 0). */
export const harness = Effect.fn(function* (
  options: {
    readonly controlId?: string;
    readonly leaseUpdates?: Stream.Stream<ComputerUseLeaseUpdate>;
    readonly expiresAt?: string;
    /** Stands in for `cua-driver revoke`; defaults to recording and returning at once. */
    readonly revoke?: (sessions: ReadonlyArray<string>) => Effect.Effect<void>;
    /**
     * Gives each driver an overlay channel; draws and sends land in `log` in order. With a gate,
     * every "show" signals `entered` and then waits for `gate`, like a helper slow to draw.
     */
    readonly overlay?: boolean | ((command: ComputerUseOverlayCommand) => Effect.Effect<void>);
    /** Pids whose windows are not on GOAT's screen; with it, the proxy checks every window. */
    readonly elsewhere?: ReadonlySet<number>;
    /** Holds every placement answer until it is done, as a slow X server would. */
    readonly placementGate?: Deferred.Deferred<void>;
    /** Answers each window report; reports land in `targets`. */
    readonly onTarget?: (target: { pid: number; windowId: number }) => boolean;
    readonly reservation?: (
      call: ComputerUseCallReservation,
    ) => Effect.Effect<ComputerUseCallAdmission>;
    readonly kill?: Effect.Effect<void>;
    readonly restartFailure?: string;
  } = {},
) {
  const input = yield* Queue.unbounded<string, Cause.Done>();
  const output = yield* Queue.unbounded<string>();
  const updates = yield* Queue.unbounded<ComputerUseLeaseUpdate, Cause.Done | string>();
  const drivers: Array<FakeDriver> = [];
  const started = yield* Queue.unbounded<FakeDriver>();
  const revokeCalled = yield* Deferred.make<void>();
  const revoked: Array<ReadonlyArray<string>> = [];
  const log: Array<string> = [];
  const checking = yield* Queue.unbounded<ReadonlyArray<NamedWindow>>();
  const targets = yield* Queue.unbounded<{ pid: number; windowId: number }>();
  const reservations: Array<ComputerUseCallReservation> = [];
  const reservationEvents = yield* Queue.unbounded<ComputerUseCallReservation>();
  const proxy = yield* runLeaseProxy({
    connectionId: "proxy:test",
    reservation: (call) =>
      Effect.sync(() => void reservations.push(call)).pipe(
        Effect.andThen(Queue.offer(reservationEvents, call)),
        Effect.andThen(
          options.reservation?.(call) ??
            Effect.succeed<ComputerUseCallAdmission>(
              call.action === "reserve"
                ? { status: "admitted", reservationId: `ticket:${call.callId}` }
                : { status: "released" },
            ),
        ),
      ),
    controlId: options.controlId ?? CONTROL,
    expiresAt: DateTime.makeUnsafe(options.expiresAt ?? "1970-01-01T00:30:00.000Z"),
    input: Stream.fromQueue(input),
    output: (line) => Queue.offer(output, line).pipe(Effect.asVoid),
    ...(options.onTarget === undefined
      ? {}
      : {
          onTarget: (target: { pid: number; windowId: number }) =>
            Queue.offer(targets, target).pipe(Effect.as(options.onTarget?.(target) ?? true)),
        }),
    leaseUpdates: options.leaseUpdates ?? Stream.fromQueue(updates),
    startDriver: Effect.gen(function* () {
      if (drivers.length > 0 && options.restartFailure !== undefined)
        return yield* Effect.fail(options.restartFailure);
      const driver: FakeDriver = {
        toDriver: yield* Queue.unbounded<string>(),
        fromDriver: yield* Queue.unbounded<string, Cause.Done>(),
        killed: yield* Deferred.make<void>(),
      };
      drivers.push(driver);
      yield* Queue.offer(started, driver);
      return {
        send: (line: string) =>
          Effect.sync(() => {
            const params = (JSON.parse(line) as { params?: { name?: unknown } }).params;
            if (typeof params?.name === "string") log.push("send " + params.name);
          }).pipe(Effect.andThen(Queue.offer(driver.toDriver, line)), Effect.asVoid),
        lines: Stream.fromQueue(driver.fromDriver),
        kill: Deferred.succeed(driver.killed, undefined).pipe(
          Effect.andThen(options.kill ?? Effect.void),
          Effect.andThen(Queue.end(driver.fromDriver)),
        ),
        ...(options.overlay
          ? {
              overlay: (command: ComputerUseOverlayCommand) =>
                (typeof options.overlay === "function"
                  ? options.overlay(command)
                  : Effect.void
                ).pipe(
                  Effect.andThen(
                    Effect.sync(() => void log.push("draw " + JSON.stringify(command))),
                  ),
                ),
            }
          : {}),
      };
    }),
    ...(options.elsewhere === undefined
      ? {}
      : {
          placement: (windows: ReadonlyArray<NamedWindow>) =>
            Queue.offer(checking, windows).pipe(
              Effect.andThen(
                options.placementGate === undefined
                  ? Effect.void
                  : Deferred.await(options.placementGate),
              ),
              Effect.as(
                windows.some((window) => options.elsewhere?.has(window.pid))
                  ? ("other" as const)
                  : ("same" as const),
              ),
            ),
        }),
    revokeSessions: (sessions) =>
      Effect.sync(() => void revoked.push(sessions)).pipe(
        Effect.andThen(Deferred.succeed(revokeCalled, undefined)),
        Effect.andThen(options.revoke?.(sessions) ?? Effect.void),
      ),
  }).pipe(Effect.scoped, Effect.forkChild);
  const first = yield* Queue.take(started);
  const current = () => drivers.at(-1) ?? first;
  const json = (line: string) => JSON.parse(line) as Record<string, unknown>;
  return {
    send: (line: string) => Queue.offer(input, line),
    close: Queue.end(input),
    push: (update: ComputerUseLeaseUpdate) => Queue.offer(updates, update),
    failLeaseStream: Queue.fail(updates, "connection reset"),
    reply: (line: string) => Queue.offer(current().fromDriver, line),
    /** The driver's output ends without the proxy killing it, as when the helper restarts. */
    driverExits: Effect.suspend(() => Queue.end(current().fromDriver)),
    nextToDriver: Effect.suspend(() => Queue.take(current().toDriver)).pipe(Effect.map(json)),
    nextToProvider: Queue.take(output).pipe(Effect.map(json)),
    providerQueued: Queue.size(output),
    driverQueued: Effect.suspend(() => Queue.size(current().toDriver)),
    killed: Effect.suspend(() => Deferred.await(first.killed)),
    isKilled: Effect.suspend(() => Deferred.isDone(first.killed)),
    restarted: Queue.take(started),
    revokeCalled: Deferred.await(revokeCalled),
    /** The windows of the next placement check, once it has started. */
    checking: Queue.take(checking),
    /** The next window the proxy reported to the server. */
    reported: Queue.take(targets),
    reportedQueued: Queue.size(targets),
    revoked,
    log,
    reservations,
    nextReservation: Queue.take(reservationEvents),
    proxy,
  };
});
