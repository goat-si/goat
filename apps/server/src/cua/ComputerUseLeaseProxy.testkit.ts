// @effect-diagnostics preferSchemaOverJson:off -- The fake driver speaks raw JSON-RPC lines.
/** The lease proxy over in-memory stdio, lease stream and drivers, for its tests. */
import {
  type ComputerUseHumanInputSource,
  type ComputerUseCallReservation,
  type ComputerUseCallAdmission,
  TurnItemId,
  type ComputerUseLeaseUpdate,
  type ComputerUseOverlayCommand,
  computerUseRefusalReason,
} from "@goat/contracts";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { NamedWindow } from "./x11WindowPlacement.ts";
import {
  LEASE_END_MESSAGES,
  MAY_HAVE_ACTED,
  READ_CUT_OFF,
  runLeaseProxy,
} from "./ComputerUseLeaseProxy.ts";

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

export interface FakeDriver {
  readonly toDriver: Queue.Queue<string>;
  readonly fromDriver: Queue.Queue<string, Cause.Done>;
  readonly killed: Deferred.Deferred<void>;
  readonly closed: Deferred.Deferred<void>;
  readonly observed: Deferred.Deferred<"reading" | "closed">;
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
    readonly kill?: Effect.Effect<void> | ((index: number) => Effect.Effect<void>);
    readonly acquire?: (index: number) => Effect.Effect<void>;
    readonly restartFailure?: string;
    /** Holds every window report until it is done, as a slow server would. */
    readonly targetGate?: Deferred.Deferred<void>;
    /**
     * Gives each driver a helper input feed (`hid`); reports to the server land in `people`,
     * answered with `acceptHuman` (true by default), and input call reports in `agentCalls`.
     */
    readonly humanInput?: boolean;
    /** The driver's manifest stamp, read at each child start and before idle calls (#1416). */
    readonly manifestStamp?: () => string | undefined;
    /** Holds the first driver's kill open until done, as a child slow to stop would. */
    readonly firstKillGate?: Deferred.Deferred<void>;
    readonly acceptHuman?: () => boolean;
    /** Holds every report of a person's input until it is done, as a slow server would. */
    readonly humanGate?: Deferred.Deferred<void>;
    /** Holds every start report until it is done, as a slow server would. */
    readonly agentInputGate?: Deferred.Deferred<void>;
  } = {},
) {
  const input = yield* Queue.unbounded<string, Cause.Done>();
  const output = yield* Queue.unbounded<string>();
  const updates = yield* Queue.unbounded<ComputerUseLeaseUpdate, Cause.Done | string>();
  const drivers: Array<FakeDriver> = [];
  const started = yield* Queue.unbounded<FakeDriver>();
  const dispatched = yield* Queue.unbounded<{ index: number; line: string }>();
  const revokeCalled = yield* Deferred.make<void>();
  const revoked: Array<ReadonlyArray<string>> = [];
  const log: Array<string> = [];
  const checking = yield* Queue.unbounded<ReadonlyArray<NamedWindow>>();
  const targets = yield* Queue.unbounded<{ pid: number; windowId: number }>();
  const people = yield* Queue.unbounded<ComputerUseHumanInputSource>();
  const taken = yield* Queue.unbounded<string>();
  const applied = yield* Queue.unbounded<string>();
  const agentCalls = yield* Queue.unbounded<string>();
  const hidFeeds: Array<Queue.Queue<{ source: ComputerUseHumanInputSource; at: number }>> = [];
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
            Queue.offer(targets, target).pipe(
              Effect.andThen(
                options.targetGate === undefined ? Effect.void : Deferred.await(options.targetGate),
              ),
              Effect.as(options.onTarget?.(target) ?? true),
            ),
        }),
    ...(options.humanInput
      ? {
          onHumanInput: (input: { source: ComputerUseHumanInputSource; at: number }) =>
            Queue.offer(people, input.source).pipe(
              Effect.andThen(
                options.humanGate === undefined ? Effect.void : Deferred.await(options.humanGate),
              ),
              Effect.as(options.acceptHuman?.() ?? true),
            ),
          onAgentInput: (report: { call: string; state: "start" | "end"; at: number }) =>
            Queue.offer(agentCalls, report.state + " " + report.call).pipe(
              Effect.andThen(
                report.state === "start" && options.agentInputGate !== undefined
                  ? Deferred.await(options.agentInputGate)
                  : Effect.void,
              ),
            ),
        }
      : {}),
    // Each update is marked taken as the proxy pulls it, and applied once the proxy has acted.
    leaseUpdates: (options.leaseUpdates ?? Stream.fromQueue(updates)).pipe(
      Stream.tap((update) => Queue.offer(taken, update.state)),
    ),
    onLeaseUpdateApplied: (update) => Queue.offer(applied, update.state).pipe(Effect.asVoid),
    startDriver: Effect.gen(function* () {
      if (drivers.length > 0 && options.restartFailure !== undefined)
        return yield* Effect.fail(options.restartFailure);
      const driver: FakeDriver = {
        toDriver: yield* Queue.unbounded<string>(),
        fromDriver: yield* Queue.unbounded<string, Cause.Done>(),
        killed: yield* Deferred.make<void>(),
        closed: yield* Deferred.make<void>(),
        observed: yield* Deferred.make<"reading" | "closed">(),
      };
      const index = drivers.length;
      drivers.push(driver);
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(driver.closed, undefined).pipe(
          Effect.andThen(Deferred.succeed(driver.observed, "closed")),
        ),
      );
      yield* Queue.offer(started, driver);
      // Bounded and sliding like the CLI's (ComputerUseLeaseProxyCli.ts): events the proxy does
      // not take in time are lost there.
      const hid = yield* Queue.sliding<{ source: ComputerUseHumanInputSource; at: number }>(16);
      hidFeeds.push(hid);
      yield* options.acquire?.(index) ?? Effect.void;
      return {
        ...(options.humanInput ? { humanInput: Stream.fromQueue(hid) } : {}),
        send: (line: string) =>
          Effect.sync(() => {
            const params = (JSON.parse(line) as { params?: { name?: unknown } }).params;
            if (typeof params?.name === "string") log.push("send " + params.name);
          }).pipe(
            Effect.andThen(Queue.offer(dispatched, { index, line })),
            Effect.andThen(Queue.offer(driver.toDriver, line)),
            Effect.asVoid,
          ),
        lines: Stream.unwrap(
          Deferred.succeed(driver.observed, "reading").pipe(
            Effect.as(Stream.fromQueue(driver.fromDriver)),
          ),
        ),
        kill: Deferred.succeed(driver.killed, undefined).pipe(
          Effect.andThen(
            typeof options.kill === "function"
              ? options.kill(index)
              : (options.kill ?? Effect.void),
          ),
          Effect.andThen(
            driver === drivers[0] && options.firstKillGate !== undefined
              ? Deferred.await(options.firstKillGate)
              : Effect.void,
          ),
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
    ...(options.manifestStamp === undefined ? {} : { manifestStamp: options.manifestStamp }),
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
    drivers,
    nextDispatch: Queue.take(dispatched).pipe(
      Effect.map(({ index, line }) => ({ index, message: json(line) })),
    ),
    /** The state of the next lease update the proxy pulled, before acting on it. */
    taken: Queue.take(taken),
    /** The state of the next lease update the proxy finished applying. */
    applied: Queue.take(applied),
    appliedQueued: Queue.size(applied),
    /** Driver children started and not killed. */
    liveDrivers: Effect.suspend(() =>
      Effect.forEach(drivers, (driver) => Deferred.isDone(driver.killed)).pipe(
        Effect.map((killed) => killed.filter((done) => !done).length),
      ),
    ),
    /** Driver children started and not yet taken with restarted. */
    startedQueued: Queue.size(started),
    revokeCalled: Deferred.await(revokeCalled),
    /** The windows of the next placement check, once it has started. */
    checking: Queue.take(checking),
    /** The next window the proxy reported to the server. */
    reported: Queue.take(targets),
    reportedQueued: Queue.size(targets),
    /** The helper saw a keyboard or pointer event `ageMs` ago. */
    hid: (source: ComputerUseHumanInputSource, ageMs = 0) =>
      Effect.suspend(() => {
        const feed = hidFeeds.at(-1);
        if (feed === undefined) return Effect.void;
        return Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => Queue.offer(feed, { source, at: now - ageMs })),
        );
      }),
    /** The next person's input the proxy reported to the server. */
    person: Queue.take(people),
    /** The next input call start or end the proxy told the server about, as "start 1". */
    agentCall: Queue.take(agentCalls),
    agentCallsQueued: Queue.size(agentCalls),
    reservations,
    nextReservation: Queue.take(reservationEvents),
    revoked,
    log,
    proxy,
  };
});

export const refusedCall = (id: number, reason: keyof typeof LEASE_END_MESSAGES) => ({
  jsonrpc: "2.0",
  id,
  result: {
    content: [{ type: "text", text: LEASE_END_MESSAGES[reason] }],
    structuredContent: { refused: computerUseRefusalReason(reason), detail: reason },
    isError: true,
  },
});

/** A call the driver already had when the control ended: it may have acted, so no refusal. */
export const cutOffCall = (id: number, reason: keyof typeof LEASE_END_MESSAGES, read = false) => ({
  jsonrpc: "2.0",
  id,
  result: {
    content: [
      {
        type: "text",
        text: `${read ? READ_CUT_OFF : MAY_HAVE_ACTED} ${LEASE_END_MESSAGES[reason]}`,
      },
    ],
    structuredContent: read
      ? { code: "interrupted", detail: reason }
      : { effect: "unverifiable", code: "interrupted", detail: reason },
    isError: true,
  },
});

export interface ToolAnswer {
  readonly id: unknown;
  readonly result: {
    readonly content: ReadonlyArray<{ readonly text: string }>;
    readonly structuredContent: Record<string, unknown>;
    readonly isError: boolean;
  };
}
