import {
  type ComputerUseControlEnd,
  type ComputerUsePauseReason,
  type ComputerUseReadiness,
  type CuaAgentBlock,
  cuaAgentBlockUnder,
  type DesktopCuaPersonStopReport,
  type DesktopCuaSessionLockReport,
  type ThreadId,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

export interface ComputerUseAuthorityChange {
  readonly kind: "stop" | "credentialRevoked" | "pause" | "private";
  readonly threadId: ThreadId;
  readonly controlId: string;
  readonly terminal?: "stopped_by_person" | "screen_locked";
}

export interface ControlActivityRecord {
  readonly threadId: ThreadId;
  readonly expiresAt: DateTime.Utc;
  readonly ended?: ComputerUseControlEnd;
  readonly idle?: boolean;
  readonly waitHeld?: boolean;
}

export const isActingControl = (record: ControlActivityRecord) =>
  record.ended === undefined && record.idle !== true;

const hasLiveControl = (controls: ReadonlyMap<ThreadId, ControlActivityRecord>, nowMs: number) =>
  [...controls.values()].some(
    (record) => record.ended === undefined && DateTime.toEpochMillis(record.expiresAt) > nowMs,
  );

export const makeAuthorityNotifier = () => {
  const listeners = new Set<(change: ComputerUseAuthorityChange) => void>();
  return {
    notify: (change: ComputerUseAuthorityChange) => {
      for (const listener of listeners) listener(change);
    },
    subscribe: (listener: (change: ComputerUseAuthorityChange) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
};

export const makeDesktopControlActive = (deps: {
  readonly signals: PubSub.PubSub<void>;
  readonly controls: ReadonlyMap<ThreadId, ControlActivityRecord>;
  readonly isPaused: () => boolean;
}): Stream.Stream<boolean> => {
  const activeControlSnapshot = Effect.map(DateTime.now, (now) => {
    const nowMs = DateTime.toEpochMillis(now);
    if (deps.isPaused()) return { active: false, remainingMs: undefined as number | undefined };
    let nextExpiryMs: number | undefined;
    for (const record of deps.controls.values()) {
      if (!isActingControl(record)) continue;
      const expiryMs = DateTime.toEpochMillis(record.expiresAt);
      if (expiryMs <= nowMs) continue;
      nextExpiryMs = nextExpiryMs === undefined ? expiryMs : Math.min(nextExpiryMs, expiryMs);
    }
    return {
      active: nextExpiryMs !== undefined,
      remainingMs: nextExpiryMs === undefined ? undefined : Math.max(0, nextExpiryMs - nowMs),
    };
  });

  const watchControlExpiry = (snapshot: {
    readonly active: boolean;
    readonly remainingMs: number | undefined;
  }): Stream.Stream<boolean> =>
    !snapshot.active || snapshot.remainingMs === undefined
      ? Stream.succeed(false)
      : Stream.concat(
          Stream.succeed(true),
          Stream.unwrap(
            Effect.sleep(Duration.millis(snapshot.remainingMs)).pipe(
              Effect.andThen(activeControlSnapshot),
              Effect.map(watchControlExpiry),
            ),
          ),
        );

  return Stream.unwrap(
    Effect.map(PubSub.subscribe(deps.signals), (subscription) =>
      Stream.concat(Stream.succeed(undefined), Stream.fromSubscription(subscription)).pipe(
        Stream.mapEffect(() => activeControlSnapshot),
        Stream.switchMap(watchControlExpiry),
        Stream.changes,
      ),
    ),
  );
};

export const makeHostSafetyHandlers = (deps: {
  readonly controls: ReadonlyMap<ThreadId, ControlActivityRecord>;
  readonly getPaused: () => ComputerUsePauseReason | undefined;
  readonly setScreenLocked: () => void;
  readonly pause: (reason: ComputerUsePauseReason, includeIdle?: boolean) => Effect.Effect<void>;
  readonly stopAllAt: (now: number) => ReadonlyArray<ThreadId>;
  readonly changed: Effect.Effect<void>;
}) => {
  let hostSessionLocked = false;
  const applyHostSessionLock = () => {
    if (!hostSessionLocked || deps.getPaused() === "screen_locked") return false;
    deps.setScreenLocked();
    return true;
  };
  const onPersonStop = (report: DesktopCuaPersonStopReport) =>
    report.reason !== "person_esc"
      ? Effect.void
      : Clock.currentTimeMillis.pipe(
          Effect.map((now) => deps.stopAllAt(now)),
          Effect.flatMap((stopped) => (stopped.length > 0 ? deps.changed : Effect.void)),
        );
  const onSessionLock = Effect.fn("ComputerUseLeases.onSessionLock")(function* (
    report: DesktopCuaSessionLockReport,
  ) {
    if (report.locked) {
      hostSessionLocked = true;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      if (!hasLiveControl(deps.controls, nowMs) || deps.getPaused() === "screen_locked") return;
      yield* deps.pause("screen_locked", true);
      return;
    }
    const wasLocked = hostSessionLocked;
    hostSessionLocked = false;
    if (wasLocked) yield* deps.changed;
  });
  return {
    applyHostSessionLock,
    clearHostSessionLock: () => {
      hostSessionLocked = false;
    },
    onPersonStop,
    onSessionLock,
  };
};

export const makeSettleAll = <E>(deps: {
  readonly controls: ReadonlyMap<ThreadId, ControlActivityRecord>;
  readonly blockedTurns: Map<ThreadId, CuaAgentBlock>;
  readonly turnEnded: (threadId: ThreadId) => Effect.Effect<boolean, E>;
  readonly openWork: (threadId: ThreadId) => Effect.Effect<boolean, E>;
  readonly changed: Effect.Effect<void>;
}) =>
  Effect.suspend(() =>
    Effect.forEach(
      [...deps.controls.values()]
        .filter(
          (record) =>
            isActingControl(record) || (record.ended === undefined && record.waitHeld === true),
        )
        .map((record) => record.threadId),
      (threadId) =>
        deps
          .turnEnded(threadId)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("computer use control left to expire", { threadId, cause }),
            ),
          ),
      { discard: true },
    ).pipe(
      Effect.andThen(
        Effect.forEach(
          [...deps.blockedTurns.keys()],
          (threadId) =>
            deps.openWork(threadId).pipe(
              Effect.flatMap((open) =>
                open || !deps.blockedTurns.delete(threadId) ? Effect.void : deps.changed,
              ),
              Effect.catch((cause) =>
                Effect.logWarning("blocked computer use turn kept until the next end", {
                  threadId,
                  cause,
                }),
              ),
            ),
          { discard: true },
        ),
      ),
    ),
  );

export const activeBlockedTurns = (
  blockedTurns: ReadonlyMap<ThreadId, CuaAgentBlock>,
  report: Option.Option<{ readonly readiness: ComputerUseReadiness }>,
) =>
  [...blockedTurns].flatMap(([threadId, recorded]) => {
    const block = Option.isSome(report)
      ? cuaAgentBlockUnder(recorded, report.value.readiness)
      : recorded;
    return block === undefined ? [] : [{ threadId, block }];
  });
