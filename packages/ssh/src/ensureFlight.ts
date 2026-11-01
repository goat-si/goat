import type {
  DesktopSshPreparationProgress,
  SshHostStatus,
  SshRuntimePhase,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { SshEnsureSupersededError, SshPreparationTimeoutError } from "./errors.ts";

const SSH_PREPARATION_TIMEOUT_MS = 900_000;
export const supersededPreparation = () =>
  new SshEnsureSupersededError({
    message: "SSH preparation superseded by a newer connection intent.",
  });

export interface PreparationAdmission {
  readonly operationId: string;
  readonly disposition: "leader" | "join" | "attachment-completion";
  readonly generation: number;
}

export interface PreparationReporter {
  readonly operationId: string;
  readonly onPhase: (phase: SshRuntimePhase, upload?: SshHostStatus["upload"]) => void;
  readonly onHostAnswered: () => void;
}

type TerminalProgress = Pick<
  DesktopSshPreparationProgress,
  "outcome" | "attachmentId" | "runtimeStatus"
>;
interface Observer {
  readonly onProgress?: (progress: DesktopSshPreparationProgress) => void;
  readonly onPhase?: PreparationReporter["onPhase"];
  readonly onHostAnswered?: (() => void) | null;
}

function notify(f: (() => void) | undefined) {
  try {
    f?.();
  } catch {
    // A detached view must never change the shared preparation or another view's result.
  }
}

let managerSequence = 0;

/** Owns work in the manager scope; caller scopes own only observations and completion leases. */
export const makeEnsureFlights = <A, E>(options: {
  readonly scope: Scope.Scope;
  readonly timeoutMs?: number;
}) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const managerId = ++managerSequence;
    let operationSequence = 0;
    let closed = false;
    type Error = E | SshEnsureSupersededError | SshPreparationTimeoutError;
    interface Flight {
      readonly key: string;
      readonly generation: number;
      readonly intent: string;
      readonly operationId: string;
      readonly deadline: bigint;
      readonly result: Deferred.Deferred<A, Error>;
      readonly drained: Deferred.Deferred<void>;
      readonly observers: Set<Observer>;
      latest: Omit<DesktopSshPreparationProgress, "remainingMs">;
      upload: SshHostStatus["upload"];
      leases: number;
      settling: boolean;
      settled: boolean;
      failed: boolean;
      worker?: Fiber.Fiber<void>;
    }
    const flights = new Map<string, Flight>();
    const observations = new WeakMap<
      Observer,
      { phase: SshRuntimePhase | null; answered: boolean; upload: SshHostStatus["upload"] }
    >();
    const remaining = (flight: Flight) =>
      Math.max(0, Math.floor(Number(flight.deadline - clock.monotonicTimeNanosUnsafe()) / 1e6));
    const replay = (flight: Flight, observer: Observer) => {
      const progress = { ...flight.latest, remainingMs: remaining(flight) };
      const previous = observations.get(observer);
      observations.set(observer, {
        phase: progress.phase,
        answered: progress.hostAnswered,
        upload: flight.upload,
      });
      notify(() => observer.onProgress?.(progress));
      if (progress.hostAnswered && previous?.answered !== true)
        notify(observer.onHostAnswered ?? undefined);
      const phase = progress.phase;
      if (
        phase !== null &&
        (previous?.phase !== phase ||
          previous.upload?.sentBytes !== flight.upload?.sentBytes ||
          previous.upload?.totalBytes !== flight.upload?.totalBytes)
      )
        notify(() => observer.onPhase?.(phase, flight.upload));
    };
    const emit = (flight: Flight) => {
      for (const observer of flight.observers) replay(flight, observer);
    };
    const drain = (flight: Flight) =>
      Effect.gen(function* () {
        if (!flight.settled || flight.leases !== 0) return;
        if (flights.get(flight.key) === flight) flights.delete(flight.key);
        yield* Deferred.succeed(flight.drained, undefined);
      });
    const retire = (key: string, interrupt = true) =>
      Effect.gen(function* () {
        const flight = flights.get(key);
        if (flight === undefined) return;
        flights.delete(key);
        flight.latest = {
          operationId: flight.operationId,
          phase: null,
          hostAnswered: flight.latest.hostAnswered,
          outcome: "superseded",
        };
        emit(flight);
        flight.settled = true;
        yield* Deferred.fail(flight.result, supersededPreparation());
        yield* Deferred.succeed(flight.drained, undefined);
        if (interrupt) flight.worker?.interruptUnsafe();
      });
    yield* Scope.addFinalizer(
      options.scope,
      Effect.gen(function* () {
        closed = true;
        for (const key of flights.keys()) yield* retire(key);
      }),
    );

    const join = <R>(
      input: Observer & {
        readonly key: string;
        readonly generation: number;
        readonly intent: string;
        readonly onAdmission?: (admission: PreparationAdmission) => void;
        readonly prepare: (report: PreparationReporter) => Effect.Effect<A, E, R>;
        readonly terminal: (value: A) => TerminalProgress;
        readonly onFailure?: (error: Error) => Effect.Effect<void>;
      },
    ): Effect.Effect<{ readonly value: A; readonly operationId: string }, Error, R | Scope.Scope> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          let flight: Flight;
          while (true) {
            if (closed || options.scope.state._tag === "Closed")
              return yield* supersededPreparation();
            const current = flights.get(input.key);
            if (current !== undefined && current.generation !== input.generation) {
              if (current.generation > input.generation) return yield* supersededPreparation();
              yield* retire(input.key);
              continue;
            }
            if (current?.failed === true) {
              yield* restore(Deferred.await(current.drained));
              continue;
            }
            if (current !== undefined && current.intent !== input.intent) {
              // A stronger policy cannot inherit a weaker result or overlap its pairing leases.
              const observer: Observer = {
                ...input,
                onProgress: (progress) =>
                  input.onProgress?.(
                    progress.phase === null
                      ? {
                          operationId: progress.operationId,
                          phase: null,
                          hostAnswered: progress.hostAnswered,
                          remainingMs: progress.remainingMs,
                          outcome: "pending",
                        }
                      : progress,
                  ),
              };
              current.observers.add(observer);
              replay(current, observer);
              yield* restore(Deferred.await(current.drained)).pipe(
                Effect.ensuring(Effect.sync(() => current.observers.delete(observer))),
              );
              continue;
            }
            if (current !== undefined) {
              flight = current;
              flight.leases++;
              flight.observers.add(input);
              notify(() =>
                input.onAdmission?.({
                  operationId: flight.operationId,
                  disposition: "join",
                  generation: flight.generation,
                }),
              );
              break;
            }
            const operationId = `ssh-preparation-${managerId}-${++operationSequence}`;
            const timeoutMs = options.timeoutMs ?? SSH_PREPARATION_TIMEOUT_MS;
            flight = {
              key: input.key,
              generation: input.generation,
              intent: input.intent,
              operationId,
              deadline: clock.monotonicTimeNanosUnsafe() + BigInt(timeoutMs) * 1_000_000n,
              result: yield* Deferred.make<A, Error>(),
              drained: yield* Deferred.make<void>(),
              observers: new Set([input]),
              upload: undefined,
              leases: 1,
              settling: false,
              settled: false,
              failed: false,
              latest: { operationId, phase: "connecting", hostAnswered: false },
            };
            flights.set(input.key, flight);
            const owned = flight;
            const report: PreparationReporter = {
              operationId,
              onPhase: (phase, upload) => {
                if (
                  owned.settling ||
                  owned.settled ||
                  (owned.latest.phase === phase &&
                    owned.upload?.sentBytes === upload?.sentBytes &&
                    owned.upload?.totalBytes === upload?.totalBytes)
                )
                  return;
                owned.upload = upload;
                owned.latest = { operationId, phase, hostAnswered: owned.latest.hostAnswered };
                emit(owned);
              },
              onHostAnswered: () => {
                if (owned.settling || owned.settled || owned.latest.hostAnswered) return;
                owned.latest = { ...owned.latest, hostAnswered: true };
                emit(owned);
              },
            };
            const worker = input.prepare(report).pipe(
              Effect.scoped,
              Effect.timeoutOrElse({
                duration: remaining(owned),
                orElse: () =>
                  Effect.fail(
                    new SshPreparationTimeoutError({
                      message: "SSH runtime preparation exceeded its 15-minute limit.",
                    }),
                  ),
              }),
              Effect.onExit((exit) =>
                Effect.gen(function* () {
                  if (owned.settled) return;
                  owned.settling = true;
                  const error = Exit.isFailure(exit)
                    ? Cause.findErrorOption(exit.cause)
                    : Option.none<Error>();
                  if (Option.isSome(error))
                    yield* (input.onFailure?.(error.value) ?? Effect.void).pipe(Effect.ignoreCause);
                  if (owned.settled) return;
                  const terminal = Exit.isSuccess(exit)
                    ? input.terminal(exit.value)
                    : {
                        outcome:
                          (Cause.hasInterrupts(exit.cause) &&
                            (closed || options.scope.state._tag === "Closed")) ||
                          (Option.isSome(error) && error.value instanceof SshEnsureSupersededError)
                            ? ("superseded" as const)
                            : ("failed" as const),
                      };
                  owned.latest = {
                    operationId,
                    phase: null,
                    hostAnswered: owned.latest.hostAnswered,
                    ...terminal,
                  };
                  owned.failed = Exit.isFailure(exit);
                  owned.settled = true;
                  emit(owned);
                  yield* Deferred.done(owned.result, exit);
                  yield* drain(owned);
                }),
              ),
              Effect.ignoreCause,
              Effect.provideService(Clock.Clock, clock),
              Effect.interruptible,
            );
            flight.worker = yield* Effect.forkIn(worker, options.scope);
            notify(() =>
              input.onAdmission?.({
                operationId,
                disposition: "leader",
                generation: input.generation,
              }),
            );
            break;
          }
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              flight.observers.delete(input);
              flight.leases--;
              yield* drain(flight);
            }),
          );
          replay(flight, input);
          const value = yield* restore(Deferred.await(flight.result));
          return { value, operationId: flight.operationId };
        }),
      );
    /**
     * A preparation for `key` is still running, so its published phase is current. Status reads
     * trust a "preparing" snapshot only while this holds: a preparation that died without
     * publishing its outcome (a defect) must not pin the host at "preparing".
     */
    const isActive = (key: string) => {
      const flight = flights.get(key);
      return flight !== undefined && !flight.settled;
    };
    return { join, retire, isActive };
  });
