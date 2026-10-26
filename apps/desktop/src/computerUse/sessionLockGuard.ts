import type { ComputerUseReadiness } from "@goat/contracts";

export const SESSION_LOCK_REASONS = [
  "screen_locked",
  "screensaver_active",
  "session_deactivated",
  "system_suspended",
] as const;

export type SessionLockReason = (typeof SESSION_LOCK_REASONS)[number];

export type SessionLockTransition = "initial" | "paused" | "resumed" | "updated";

export interface SessionLockSnapshot {
  readonly locked: boolean;
  readonly reasons: ReadonlyArray<SessionLockReason>;
  readonly watching: boolean;
  readonly transition: SessionLockTransition;
  readonly changedReason?: SessionLockReason | undefined;
}

export interface PowerMonitorLike {
  readonly on: (event: string, listener: () => void) => unknown;
  readonly removeListener?: ((event: string, listener: () => void) => unknown) | undefined;
  readonly off?: ((event: string, listener: () => void) => unknown) | undefined;
}

export interface SessionLockPollFacts {
  readonly screenLocked?: boolean | undefined;
  readonly screensaverActive?: boolean | undefined;
  readonly sessionActive?: boolean | undefined;
  readonly systemSuspended?: boolean | undefined;
  readonly inputDesktop?: "Default" | "other" | "unavailable" | string | undefined;
  readonly connectState?: "active" | "disconnected" | "unknown" | string | undefined;
  readonly interactiveSession?: boolean | undefined;
  readonly blockers?: ComputerUseReadiness["blockers"] | undefined;
}

export interface SessionLockGuard {
  readonly snapshot: () => SessionLockSnapshot;
  readonly setWatching: (watching: boolean) => SessionLockSnapshot;
  readonly reportReason: (reason: SessionLockReason, active: boolean) => SessionLockSnapshot;
  readonly reportPoll: (facts: SessionLockPollFacts) => SessionLockSnapshot;
  readonly attachPowerMonitor: (emitter: PowerMonitorLike) => () => void;
  readonly reset: () => SessionLockSnapshot;
}

/**
 * Tracks host screen lock, screensaver, user-session switch, and system suspend state while
 * desktop computer-use control is active. Pauses control on the first active lock reason and
 * resumes only after every active lock reason has cleared.
 */
export function makeSessionLockGuard(
  deps: {
    readonly onPause?: ((snapshot: SessionLockSnapshot) => void) | undefined;
    readonly onResume?: ((snapshot: SessionLockSnapshot) => void) | undefined;
    readonly onChange?: ((snapshot: SessionLockSnapshot) => void) | undefined;
  } = {},
): SessionLockGuard {
  const activeReasons = new Set<SessionLockReason>();
  let watching = false;
  let pausedWhileWatching = false;
  let lastTransition: SessionLockTransition = "initial";
  let lastChangedReason: SessionLockReason | undefined;

  const orderedReasons = (): ReadonlyArray<SessionLockReason> =>
    SESSION_LOCK_REASONS.filter((reason) => activeReasons.has(reason));

  const currentSnapshot = (
    transition: SessionLockTransition = lastTransition,
    changedReason: SessionLockReason | undefined = lastChangedReason,
  ): SessionLockSnapshot => ({
    locked: activeReasons.size > 0,
    reasons: orderedReasons(),
    watching,
    transition,
    ...(changedReason === undefined ? {} : { changedReason }),
  });

  const applyReasonMutation = (
    mutate: () => SessionLockReason | undefined,
  ): SessionLockSnapshot => {
    const wasLocked = activeReasons.size > 0;
    const changedReason = mutate();
    const isLocked = activeReasons.size > 0;

    if (changedReason === undefined) {
      return currentSnapshot();
    }

    let transition: SessionLockTransition = "updated";
    if (watching && !wasLocked && isLocked) {
      pausedWhileWatching = true;
      transition = "paused";
    } else if (watching && pausedWhileWatching && wasLocked && !isLocked) {
      pausedWhileWatching = false;
      transition = "resumed";
    }

    lastTransition = transition;
    lastChangedReason = changedReason;
    const snap = currentSnapshot(transition, changedReason);
    deps.onChange?.(snap);
    if (transition === "paused") deps.onPause?.(snap);
    if (transition === "resumed") deps.onResume?.(snap);
    return snap;
  };

  const toggleReason = (
    reason: SessionLockReason,
    active: boolean,
  ): SessionLockReason | undefined => {
    const had = activeReasons.has(reason);
    if (active && !had) {
      activeReasons.add(reason);
      return reason;
    }
    if (!active && had) {
      activeReasons.delete(reason);
      return reason;
    }
    return undefined;
  };

  const reportReason = (reason: SessionLockReason, active: boolean): SessionLockSnapshot =>
    applyReasonMutation(() => toggleReason(reason, active));

  const reportPoll = (facts: SessionLockPollFacts): SessionLockSnapshot =>
    applyReasonMutation(() => {
      let changed: SessionLockReason | undefined;
      const record = (reason: SessionLockReason, active: boolean) => {
        const updated = toggleReason(reason, active);
        if (updated !== undefined && changed === undefined) changed = updated;
      };

      const blockers = facts.blockers ? new Set(facts.blockers) : undefined;
      const screenLocked =
        facts.screenLocked ??
        (facts.inputDesktop !== undefined
          ? facts.inputDesktop !== "Default"
          : blockers !== undefined
            ? blockers.has("screenLocked")
            : undefined);
      if (screenLocked !== undefined) {
        record("screen_locked", screenLocked);
      }

      if (facts.screensaverActive !== undefined) {
        record("screensaver_active", facts.screensaverActive);
      }

      const sessionDeactivated =
        facts.sessionActive !== undefined
          ? !facts.sessionActive
          : facts.connectState !== undefined || facts.interactiveSession !== undefined
            ? facts.connectState === "disconnected" || facts.interactiveSession === false
            : blockers !== undefined
              ? blockers.has("otherUserAtConsole") || blockers.has("noInteractiveDesktop")
              : undefined;
      if (sessionDeactivated !== undefined) {
        record("session_deactivated", sessionDeactivated);
      }

      if (facts.systemSuspended !== undefined) {
        record("system_suspended", facts.systemSuspended);
      }

      return changed;
    });

  return {
    snapshot: () => currentSnapshot(),
    setWatching: (nextWatching: boolean): SessionLockSnapshot => {
      if (watching === nextWatching) return currentSnapshot();
      watching = nextWatching;
      if (watching && activeReasons.size > 0) {
        pausedWhileWatching = true;
        lastTransition = "paused";
        lastChangedReason = orderedReasons()[0];
        const snap = currentSnapshot("paused", lastChangedReason);
        deps.onChange?.(snap);
        deps.onPause?.(snap);
        return snap;
      }
      if (!watching) {
        pausedWhileWatching = false;
      }
      lastTransition = "updated";
      lastChangedReason = undefined;
      const snap = currentSnapshot("updated", undefined);
      deps.onChange?.(snap);
      return snap;
    },
    reportReason,
    reportPoll,
    attachPowerMonitor: (emitter: PowerMonitorLike): (() => void) => {
      const bindings: ReadonlyArray<readonly [string, () => void]> = [
        ["lock-screen", () => void reportReason("screen_locked", true)],
        [
          "unlock-screen",
          () => {
            void applyReasonMutation(() => {
              const c1 = toggleReason("screen_locked", false);
              const c2 = toggleReason("screensaver_active", false);
              return c1 ?? c2;
            });
          },
        ],
        ["suspend", () => void reportReason("system_suspended", true)],
        ["resume", () => void reportReason("system_suspended", false)],
        ["user-did-resign-active", () => void reportReason("session_deactivated", true)],
        [
          "user-did-become-active",
          () => {
            void applyReasonMutation(() => {
              const c1 = toggleReason("session_deactivated", false);
              const c2 = toggleReason("screensaver_active", false);
              return c1 ?? c2;
            });
          },
        ],
      ];
      for (const [event, handler] of bindings) {
        emitter.on(event, handler);
      }
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        for (const [event, handler] of bindings) {
          if (emitter.removeListener) {
            emitter.removeListener(event, handler);
          } else if (emitter.off) {
            emitter.off(event, handler);
          }
        }
      };
    },
    reset: (): SessionLockSnapshot => {
      activeReasons.clear();
      watching = false;
      pausedWhileWatching = false;
      lastTransition = "initial";
      lastChangedReason = undefined;
      return currentSnapshot("initial", undefined);
    },
  };
}
