import { describe, expect, it } from "@effect/vitest";

import {
  SESSION_LOCK_REASONS,
  type SessionLockSnapshot,
  makeSessionLockGuard,
} from "./sessionLockGuard.ts";

function makeFakePowerMonitor() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    on: (event: string, listener: () => void) => {
      const set = listeners.get(event) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener: (event: string, listener: () => void) => {
      listeners.get(event)?.delete(listener);
    },
    emit: (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

describe("sessionLockGuard", () => {
  it("pauses on lock-screen and resumes on unlock-screen while watching", () => {
    const paused: Array<SessionLockSnapshot> = [];
    const resumed: Array<SessionLockSnapshot> = [];
    const guard = makeSessionLockGuard({
      onPause: (snap) => paused.push(snap),
      onResume: (snap) => resumed.push(snap),
    });
    const power = makeFakePowerMonitor();
    const detach = guard.attachPowerMonitor(power);

    guard.setWatching(true);
    power.emit("lock-screen");
    power.emit("lock-screen");
    expect(paused).toHaveLength(1);
    expect(paused[0]).toEqual({
      locked: true,
      reasons: ["screen_locked"],
      watching: true,
      transition: "paused",
      changedReason: "screen_locked",
    });

    power.emit("unlock-screen");
    power.emit("unlock-screen");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toEqual({
      locked: false,
      reasons: [],
      watching: true,
      transition: "resumed",
      changedReason: "screen_locked",
    });

    detach();
    power.emit("lock-screen");
    expect(guard.snapshot().locked).toBe(false);
    expect(paused).toHaveLength(1);
  });

  it("keeps the session paused across overlapping suspend and screen-lock reasons until all clear", () => {
    const paused: Array<SessionLockSnapshot> = [];
    const resumed: Array<SessionLockSnapshot> = [];
    const guard = makeSessionLockGuard({
      onPause: (snap) => paused.push(snap),
      onResume: (snap) => resumed.push(snap),
    });
    const power = makeFakePowerMonitor();
    guard.attachPowerMonitor(power);
    guard.setWatching(true);

    power.emit("suspend");
    power.emit("lock-screen");
    expect(paused).toHaveLength(1);
    expect(guard.snapshot().reasons).toEqual(["screen_locked", "system_suspended"]);

    power.emit("resume");
    expect(resumed).toHaveLength(0);
    expect(guard.snapshot().locked).toBe(true);
    expect(guard.snapshot().reasons).toEqual(["screen_locked"]);

    power.emit("unlock-screen");
    expect(resumed).toHaveLength(1);
    expect(guard.snapshot().locked).toBe(false);
  });

  it("fires onPause immediately when setWatching(true) starts on an already locked host and preserves lock state across watch toggles", () => {
    const paused: Array<SessionLockSnapshot> = [];
    const resumed: Array<SessionLockSnapshot> = [];
    const guard = makeSessionLockGuard({
      onPause: (snap) => paused.push(snap),
      onResume: (snap) => resumed.push(snap),
    });

    guard.reportReason("screen_locked", true);
    expect(paused).toHaveLength(0);

    guard.setWatching(true);
    expect(paused).toHaveLength(1);
    expect(paused[0]?.transition).toBe("paused");

    guard.setWatching(false);
    expect(resumed).toHaveLength(0);
    expect(guard.snapshot().locked).toBe(true);

    guard.setWatching(true);
    expect(paused).toHaveLength(2);

    guard.reset();
    expect(guard.snapshot()).toEqual({
      locked: false,
      reasons: [],
      watching: false,
      transition: "initial",
    });
  });

  it("reconciles polled Windows desktop and readiness blocker facts in canonical reason order", () => {
    const paused: Array<SessionLockSnapshot> = [];
    const resumed: Array<SessionLockSnapshot> = [];
    const guard = makeSessionLockGuard({
      onPause: (snap) => paused.push(snap),
      onResume: (snap) => resumed.push(snap),
    });
    guard.setWatching(true);

    const lockedSnap = guard.reportPoll({
      inputDesktop: "Winlogon",
      connectState: "disconnected",
      interactiveSession: false,
      screensaverActive: true,
      systemSuspended: true,
    });
    expect(lockedSnap.reasons).toEqual(SESSION_LOCK_REASONS);
    expect(paused).toHaveLength(1);

    guard.reportPoll({
      blockers: ["screenLocked"],
      screensaverActive: false,
      systemSuspended: false,
    });
    expect(guard.snapshot().reasons).toEqual(["screen_locked"]);
    expect(resumed).toHaveLength(0);

    guard.reportPoll({
      blockers: [],
    });
    expect(guard.snapshot().locked).toBe(false);
    expect(resumed).toHaveLength(1);
  });
});
