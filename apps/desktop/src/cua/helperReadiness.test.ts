import { describe, expect, it } from "@effect/vitest";
import { CUA_STALE_ACCESSIBILITY_ADVICE } from "@goat/contracts";

import {
  initialHelperReadiness,
  toReadiness,
  withGrants,
  withProof,
  withUnreadGrants,
} from "./helperReadiness.ts";

const accessibilityOff = withGrants(
  initialHelperReadiness,
  { accessibility: false, screenRecording: true },
  false,
);

describe("helper readiness reasons", () => {
  it("tells a macOS person an Accessibility switch that is already on may need switching off and on", () => {
    expect(toReadiness(accessibilityOff, "GOAT Computer Use", "darwin").reasons).toContain(
      CUA_STALE_ACCESSIBILITY_ADVICE,
    );
  });

  it("does not give that macOS advice on Windows", () => {
    expect(toReadiness(accessibilityOff, "GOAT Computer Use", "win32").reasons).not.toContain(
      CUA_STALE_ACCESSIBILITY_ADVICE,
    );
  });
});

describe("a grant read the helper did not answer", () => {
  const unread = "GOAT Computer Use did not answer: it took too long.";
  const reasons = (state: Parameters<typeof toReadiness>[0]) =>
    toReadiness(state, "GOAT Computer Use", "darwin").reasons;

  it("says the grants could not be read, and calls no grant macOS never answered about off", () => {
    const first = withUnreadGrants(initialHelperReadiness, unread);
    expect(toReadiness(first, "GOAT Computer Use", "darwin").grants).toEqual({
      accessibility: "unknown",
      screenCapture: "unknown",
    });
    expect(reasons(first)[0]).toBe(unread);
    expect(reasons(first).join(" ")).not.toContain("not on for");
    expect(reasons(first)).not.toContain(CUA_STALE_ACCESSIBILITY_ADVICE);
  });

  it("still reports a grant macOS last answered was off as off", () => {
    expect(reasons(withUnreadGrants(accessibilityOff, unread))).toEqual(
      expect.arrayContaining([unread, "Accessibility is not on for GOAT Computer Use."]),
    );
  });

  it("drops the unanswered read once a read answers", () => {
    const answered = withGrants(
      withUnreadGrants(initialHelperReadiness, unread),
      { accessibility: false, screenRecording: false },
      false,
    );
    expect(reasons(answered)).not.toContain(unread);
    expect(reasons(answered)).toContain(
      "Accessibility and Screen Recording are not on for GOAT Computer Use.",
    );
  });
});

describe("an Accessibility grant macOS says is on but refuses", () => {
  const granted = withGrants(
    initialHelperReadiness,
    { accessibility: true, screenRecording: true },
    false,
  );
  const treeFailed = withProof(granted, {
    capture: "ready",
    elements: 0,
    screenLocked: false,
    details: ["The driver could not read GOAT's window."],
  });

  it("reads as stale, not granted, once a real tree read fails under it", () => {
    const readiness = toReadiness(treeFailed, "GOAT Computer Use", "darwin");
    expect(readiness.grants.accessibility).toBe("granted");
    expect(readiness.blockers).toContain("accessibilityStale");
  });

  it("stays plain granted once a tree read passes", () => {
    const passed = withProof(granted, {
      capture: "ready",
      elements: 12,
      screenLocked: false,
      details: [],
    });
    expect(toReadiness(passed, "GOAT Computer Use", "darwin").blockers).not.toContain(
      "accessibilityStale",
    );
  });

  it("is not called stale before any tree read, or on Windows", () => {
    expect(toReadiness(granted, "GOAT Computer Use", "darwin").blockers).not.toContain(
      "accessibilityStale",
    );
    expect(toReadiness(treeFailed, "GOAT Computer Use", "win32").blockers).not.toContain(
      "accessibilityStale",
    );
  });
});
