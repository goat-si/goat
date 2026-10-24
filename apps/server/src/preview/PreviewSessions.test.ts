import { EnvironmentId, previewSessionChip, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { browserSession, desktopSession } from "./PreviewSessions.ts";

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
};
const active = {
  _tag: "active",
  expiresAt: control.expiresAt,
  apps: ["com.apple.calculator"],
  wakeAt: 0,
} as const;

describe("preview sessions", () => {
  it("shows a browser tab and a desktop control with the same owner, status and controls", () => {
    const browser = browserSession(base, tab)!;
    const desktop = desktopSession(base, control, active)!;
    for (const session of [browser, desktop]) {
      expect(session.owner).toBe("agent");
      expect(session.status).toBe("acting");
      expect(session.capabilities.controls).toEqual(["takeover", "stop", "stopAll"]);
      expect(previewSessionChip(session)).toBe("Agent controlling");
    }
    expect(desktop.target).toEqual({ kind: "desktop", title: "com.apple.calculator" });
    expect(desktop.lease?.scope).toEqual(["com.apple.calculator"]);
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

    const collided = desktopSession(base, control, { _tag: "paused", reason: "human_input" })!;
    expect([previewSessionChip(collided), collided.reason]).toEqual([
      "Waiting for you",
      "userIntervened",
    ]);
    const takenOver = desktopSession(base, control, { _tag: "paused", reason: "takeover" })!;
    expect(previewSessionChip(takenOver)).toBe("You're controlling");
    expect(takenOver.capabilities.controls).toEqual(["handBack", "stop", "stopAll"]);
    const ended = desktopSession(base, control, { _tag: "ended", reason: "stopped_all" })!;
    expect(previewSessionChip(ended)).toBe("Stopped");
  });

  it("leaves out a person's own tab and controls that ended without a person's stop", () => {
    expect(browserSession(base, { ...tab, agentId: null })).toBeUndefined();
    for (const reason of ["expired", "revoked", "replaced", "disabled"] as const)
      expect(desktopSession(base, control, { _tag: "ended", reason })).toBeUndefined();
  });
});
