import {
  AuthSessionId,
  EnvironmentId,
  HandoffError,
  previewSessionChip,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import { it as effectIt } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";

import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import { describe, expect, it } from "vite-plus/test";

import * as PreviewSessions from "./PreviewSessions.ts";
import { blockedSession, browserSession, desktopSession } from "./PreviewSessions.ts";

const base = { environmentId: EnvironmentId.make("env"), host: "mac", platform: "mac" } as const;
const threadId = ThreadId.make("thread-agent");
const tab = {
  threadId,
  tabId: "tab-1",
  url: "https://login.example/",
  title: "Sign in",
  agentId: "agent-session",
  humanControls: false,
  private: false,
  agentStopped: false,
};
const control = {
  controlId: "control:1",
  threadId,
  expiresAt: DateTime.makeUnsafe("2030-01-01T00:00:00.000Z"),
  acted: true,
};
const detected = { humanInput: true, privateMode: true, frames: true } as const;
const active = {
  _tag: "active",
  expiresAt: control.expiresAt,
  apps: ["com.apple.calculator"],
  wakeAt: 0,
  interruptions: { count: 0, last: "human_input" },
} as const;

describe("preview sessions", () => {
  it("shows a browser tab and a desktop control with the same owner, status and controls", () => {
    const browser = browserSession(base, tab)!;
    const desktop = desktopSession(base, control, active, detected)!;
    for (const session of [browser, desktop]) {
      expect(session.owner).toBe("agent");
      expect(session.status).toBe("acting");
      expect(session.capabilities.controls).toEqual(["takeover", "stop", "stopAll"]);
      expect(previewSessionChip(session)).toBe("Agent controlling");
    }
    expect(desktop.target).toEqual({ kind: "desktop", title: "com.apple.calculator" });
    expect(desktop.lease?.scope).toEqual(["com.apple.calculator"]);
  });

  it("carries the agent's cursor on the target window, and only while the agent acts", () => {
    const cursor = { windowId: 3, point: { fx: 0.25, fy: 0.75 }, phase: "acting" } as const;
    const targeted = { ...control, target: { pid: 7, windowId: 3 }, cursor };
    expect(desktopSession(base, targeted, active, detected)!.target).toEqual({
      kind: "desktop",
      pid: 7,
      windowId: 3,
      cursor,
      title: "com.apple.calculator",
    });
    const paused = { _tag: "paused", reason: "takeover" } as const;
    // A person holds the screen, or the control ended: the agent's cursor is not shown.
    expect(desktopSession(base, targeted, paused, detected)!.target).not.toHaveProperty("cursor");
  });

  it("shows a turn blocked on a missing grant as permission-needed, with nothing to stop (#1399)", () => {
    const session = blockedSession(base, threadId, {
      reason: "permissionsNotGranted",
      missing: ["accessibility", "screenRecording"],
      holder: "helper",
    });
    expect(previewSessionChip(session)).toBe("Permission needed");
    expect(session.reason).toBe("permissionsNotGranted");
    expect(session.capabilities.controls).toEqual([]);
    expect(session.target).toEqual({
      kind: "desktop",
      title: "Allow GOAT Computer Use in Accessibility and Screen & System Audio Recording",
    });
  });

  it("shows a turn the Windows helper cannot run on this desktop as permission-needed, saying where to act (#1516)", () => {
    const session = blockedSession(base, threadId, {
      reason: "desktopUnavailable",
      blocker: "noInteractiveDesktop",
      detail: "GOAT runs in Windows Session 0 (a service or SSH session), which has no desktop.",
    });
    expect(previewSessionChip(session)).toBe("Permission needed");
    expect(session.reason).toBe("helperUnavailable");
    expect(session.capabilities.controls).toEqual([]);
    expect(session.target).toEqual({
      kind: "desktop",
      title: "Start GOAT from the signed-in Windows desktop",
    });
    const locked = blockedSession(base, threadId, {
      reason: "desktopUnavailable",
      blocker: "screenLocked",
      detail: "The screen is locked or showing a Windows security prompt.",
    });
    expect(locked.reason).toBe("screenLocked");
  });

  it("names every state with the chips both kinds share", () => {
    expect(previewSessionChip(browserSession(base, { ...tab, private: true })!)).toBe(
      "Private (paused)",
    );
    expect(previewSessionChip(browserSession(base, { ...tab, humanControls: true })!)).toBe(
      "You're controlling",
    );
    const stopped = browserSession(base, { ...tab, agentStopped: true })!;
    expect([previewSessionChip(stopped), stopped.reason]).toEqual([
      "Stopped",
      "userStoppedSession",
    ]);
    expect(stopped.capabilities.controls).toEqual(["handBack", "stopAll"]);

    const collided = desktopSession(
      base,
      control,
      { _tag: "paused", reason: "human_input" },
      detected,
    )!;
    expect([previewSessionChip(collided), collided.reason]).toEqual([
      "Waiting for you",
      "userIntervened",
    ]);
    const takenOver = desktopSession(
      base,
      control,
      { _tag: "paused", reason: "takeover" },
      detected,
    )!;
    expect(previewSessionChip(takenOver)).toBe("You're controlling");
    expect(takenOver.capabilities.controls).toEqual(["handBack", "stop", "stopAll"]);
    const ended = desktopSession(
      base,
      control,
      { _tag: "ended", reason: "stopped_all" },
      detected,
    )!;
    const secret = desktopSession(base, control, { _tag: "paused", reason: "private" }, detected)!;
    expect([previewSessionChip(secret), secret.status]).toEqual(["Private (paused)", "paused"]);
    // A host whose helper cannot detect these says so instead of implying protection.
    const blind = desktopSession(base, control, active, {
      humanInput: false,
      privateMode: false,
      frames: false,
    })!;
    expect(blind.capabilities).toMatchObject({ privateMode: false, humanInput: false });
    expect(previewSessionChip(ended)).toBe("Stopped");
  });

  it("leaves out a person's own tab and controls that ended without a person's stop", () => {
    expect(browserSession(base, { ...tab, agentId: null })).toBeUndefined();
    for (const reason of ["expired", "revoked", "replaced", "disabled"] as const)
      expect(desktopSession(base, control, { _tag: "ended", reason }, detected)).toBeUndefined();
  });

  it("leaves out a control between its thread's turns, when no agent acts on the screen", () => {
    expect(desktopSession(base, { ...control, idle: true }, active, detected)).toBeUndefined();
    // A person's stop still shows until the next turn replaces it.
    expect(
      desktopSession(
        base,
        { ...control, idle: true },
        { _tag: "ended", reason: "stopped" },
        detected,
      ),
    ).toBeDefined();
  });

  it("leaves out a turn's control until its agent asks to act, so a browser tab gets one card", () => {
    const { acted: _acted, ...unused } = control;
    // A person moving the mouse pauses every control, the unused one included.
    for (const state of [active, { _tag: "paused", reason: "human_input" } as const])
      expect(desktopSession(base, unused, state, detected)).toBeUndefined();
    expect(
      desktopSession(base, unused, { _tag: "ended", reason: "stopped_all" }, detected),
    ).toBeUndefined();
  });

  it("keeps a stopped control's app label instead of calling it the whole screen", () => {
    const stopped = { _tag: "ended", reason: "stopped" } as const;
    const none = desktopSession(base, { ...control, scope: { apps: [] } }, stopped, detected)!;
    expect(none.target).toEqual({ kind: "desktop", title: "No apps approved" });
    expect(none.lease?.scope).toEqual([]);
    const whole = desktopSession(
      base,
      { ...control, scope: { apps: undefined } },
      stopped,
      detected,
    )!;
    expect(whole.target).toEqual({ kind: "desktop", title: "Whole screen" });
    // Never seen active: nothing says which apps it held.
    expect(desktopSession(base, control, stopped, detected)!.target).toEqual({
      kind: "desktop",
      title: "Computer use",
    });
  });

  it("shows a stopped agent as stopped while a person holds the tab or types a secret in it", () => {
    for (const held of [{ humanControls: true }, { private: true }]) {
      const session = browserSession(base, { ...tab, ...held, agentStopped: true })!;
      // Stop all after a takeover must still leave a card that says stopped and can close.
      expect(session.status).toBe("stopped");
      expect(session.capabilities.controls).toEqual(["handBack", "stopAll"]);
    }
    expect(browserSession(base, { ...tab, private: true, agentStopped: true })!.owner).toBe(
      "private",
    );
  });

  effectIt.effect("stops every agent without waiting on a page that never answers", () => {
    const stopped: Array<string> = [];
    const layer = PreviewSessions.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ServerBrowser.ServerBrowser)({
            // A hung renderer: reading a tab's title never finishes.
            sessions: Effect.never,
            stopAllAgents: Effect.sync(() => void stopped.push("browser")),
          }),
          Layer.mock(ComputerUseLeases.ComputerUseLeases)({
            release: () => Effect.void,
            foregroundApprovalEpoch: Effect.die("unused"),
            stopAll: Effect.sync(() => (stopped.push("desktop"), [])),
            grants: Effect.succeed([]),
            // The live picture service listens for control changes from the start.
            subscribe: PubSub.unbounded<void>().pipe(Effect.flatMap(PubSub.subscribe)),
            proxy: undefined,
          }),
          Layer.mock(Handoffs.Handoffs)({}),
          Layer.mock(ServerEnvironment.ServerEnvironment)({}),
        ),
      ),
    );
    return Effect.gen(function* () {
      const sessions = yield* PreviewSessions.PreviewSessions;
      const result = yield* sessions.control({ control: "stopAll" }, AuthSessionId.make("session"));
      expect(result).toEqual({ applied: true });
      expect(stopped).toEqual(["browser", "desktop"]);
    }).pipe(Effect.provide(layer));
  });

  effectIt.effect("says Stop all did not apply when a screen grant stays alive", () => {
    const layer = PreviewSessions.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ServerBrowser.ServerBrowser)({ stopAllAgents: Effect.void }),
          Layer.mock(ComputerUseLeases.ComputerUseLeases)({
            release: () => Effect.void,
            stopAll: Effect.succeed([]),
            grants: Effect.succeed([
              {
                threadId,
                handoffId: TurnItemId.make("handoff:kept"),
                expiresAt: control.expiresAt,
              },
            ]),
            subscribe: PubSub.unbounded<void>().pipe(Effect.flatMap(PubSub.subscribe)),
            proxy: undefined,
          }),
          // The grant cannot be ended, so its thread could take the screen again next turn.
          Layer.mock(Handoffs.Handoffs)({
            respond: () => Effect.fail(new HandoffError({ reason: "unavailable" })),
          }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({}),
        ),
      ),
    );
    return Effect.gen(function* () {
      const sessions = yield* PreviewSessions.PreviewSessions;
      const result = yield* sessions.control({ control: "stopAll" }, AuthSessionId.make("session"));
      expect(result).toEqual({ applied: false, reason: "not_allowed" });
    }).pipe(Effect.provide(layer));
  });

  // #1519: the card's Stop ended the control and left the grant holding the app for 30 minutes.
  effectIt.effect("a card's Stop ends that thread's grant and leaves other threads' grants", () => {
    const stopped: Array<string> = [];
    const ended: Array<string> = [];
    const other = ThreadId.make("thread-other");
    const layer = PreviewSessions.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ServerBrowser.ServerBrowser)({}),
          Layer.mock(ComputerUseLeases.ComputerUseLeases)({
            release: () => Effect.void,
            sessions: Effect.succeed([{ control, state: active }]),
            stop: (thread) => Effect.sync(() => (stopped.push(thread), true)),
            grants: Effect.succeed([
              { threadId, handoffId: TurnItemId.make("handoff:own"), expiresAt: control.expiresAt },
              {
                threadId: other,
                handoffId: TurnItemId.make("handoff:other"),
                expiresAt: control.expiresAt,
              },
            ]),
            subscribe: PubSub.unbounded<void>().pipe(Effect.flatMap(PubSub.subscribe)),
            proxy: undefined,
          }),
          Layer.mock(Handoffs.Handoffs)({
            respond: (input) =>
              Effect.sync(() => void ended.push(`${input.handoffId}:${input.action}`)).pipe(
                Effect.as({} as never),
              ),
          }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({}),
        ),
      ),
    );
    return Effect.gen(function* () {
      const sessions = yield* PreviewSessions.PreviewSessions;
      const result = yield* sessions.control(
        { control: "stop", sessionId: `desktop:${control.controlId}` },
        AuthSessionId.make("session"),
      );
      expect(result).toEqual({ applied: true });
      expect(stopped).toEqual([threadId]);
      expect(ended).toEqual(["handoff:own:cancelled"]);
    }).pipe(Effect.provide(layer));
  });
});
