import { describe, expect, it } from "vite-plus/test";

import { computerUseStatusText } from "./CuaSetupDialog.logic";

const mac = { platform: "darwin", running: true } as const;

describe("computerUseStatusText", () => {
  it("shows a grant revoked in System Settings even while the driver still runs", () => {
    expect(
      computerUseStatusText({
        enabled: true,
        status: mac,
        error: null,
        missingGrants: ["screen-recording"],
      }),
    ).toBe("Screen Recording is off. Choose Set up to allow it again.");
    expect(
      computerUseStatusText({
        enabled: true,
        status: mac,
        error: null,
        missingGrants: ["accessibility", "screen-recording"],
      }),
    ).toBe("Accessibility and Screen Recording are off. Choose Set up to allow it again.");
  });

  it("reports the host's last failure until a session starts the driver", () => {
    const failure =
      "Allow Accessibility and Screen Recording in System Settings, then restart computer use.";
    expect(
      computerUseStatusText({
        enabled: true,
        status: { platform: "darwin", running: false, failure },
        error: null,
        missingGrants: [],
      }),
    ).toBe(failure);
    expect(
      computerUseStatusText({
        enabled: true,
        status: { platform: "linux", running: false },
        error: null,
        missingGrants: [],
      }),
    ).toBe("Starts with the next agent turn");
    expect(
      computerUseStatusText({ enabled: false, status: mac, error: null, missingGrants: [] }),
    ).toBeNull();
  });
});
