import { describe, expect, it } from "@effect/vitest";
import { CUA_STALE_ACCESSIBILITY_ADVICE } from "@goat/contracts";

import { initialHelperReadiness, toReadiness, withGrants } from "./helperReadiness.ts";

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
