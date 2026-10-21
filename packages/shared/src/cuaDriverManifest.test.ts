import { describe, expect, it } from "vite-plus/test";

import {
  CUA_DRIVER_ALLOWED_TOOLS,
  CUA_DRIVER_EXCLUDED_TOOLS,
  admittedCuaApplications,
  cuaDriverCapabilityManifest,
  isCuaDriverStartupRefusal,
} from "./cuaDriverManifest.ts";

describe("cuaDriverManifest", () => {
  it("keeps every admin, install, file and exfiltration tool out of the allow list", () => {
    const allowed = new Set<string>(CUA_DRIVER_ALLOWED_TOOLS);
    for (const tool of Object.keys(CUA_DRIVER_EXCLUDED_TOOLS))
      expect(allowed.has(tool), tool).toBe(false);
    for (const tool of [
      "install_extension",
      "install_ffmpeg",
      "set_config",
      "check_for_update",
      "replay_trajectory",
      "parse_visual_regions",
      "page",
      "escalate_session",
      "get_session_state",
      "browser_download",
      "browser_set_input_files",
      "clipboard_read",
      "kill_app",
    ])
      expect(Object.keys(CUA_DRIVER_EXCLUDED_TOOLS)).toContain(tool);
  });

  it("admits every listed app except GOAT, the driver and credential stores", () => {
    expect(
      admittedCuaApplications(
        [
          { bundle_id: "com.apple.finder", name: "Finder" },
          { bundle_id: "si.goat.desktop", name: "GOAT" },
          { bundle_id: "com.trycua.driver", name: "CuaDriver" },
          { bundle_id: "com.apple.Passwords", name: "Passwords" },
          { bundle_id: "com.1password.1password", name: "1Password" },
          { bundle_id: "org.example.vault", name: "Bitwarden" },
          { bundle_id: "com.apple.TextEdit", name: "TextEdit" },
          { bundle_id: "com.apple.TextEdit", name: "TextEdit" },
          { bundle_id: null, name: "unidentified" },
        ],
        ["SI.GOAT.DESKTOP"],
      ),
    ).toEqual(["com.apple.TextEdit", "com.apple.finder"]);
  });

  it("writes a v3 manifest: tools, display, admitted apps and no file or profile scope", () => {
    const text = cuaDriverCapabilityManifest({
      applications: ['com.example."quoted"'],
      tools: ["list_apps", "click"],
    });
    expect(text).toBe(
      [
        "# Written by GOAT at each driver start. See ADR-0020.",
        "version: 3",
        "resources:",
        "  desktop:",
        "    display: true",
        "  apps:",
        '    - bundle_id: "com.example.\\"quoted\\""',
        "allow:",
        "  tools:",
        '    - "list_apps"',
        '    - "click"',
        "",
      ].join("\n"),
    );
    expect(cuaDriverCapabilityManifest({ applications: [] })).toContain("  apps: []");
    expect(cuaDriverCapabilityManifest({ applications: [] })).not.toMatch(
      /files|browser|processes/,
    );
  });

  it("recognizes the driver's startup refusal through wrapped causes", () => {
    const sdk = new Error("embedded cua-driver exited before readiness (code=Some(64))");
    expect(isCuaDriverStartupRefusal(sdk)).toBe(true);
    expect(isCuaDriverStartupRefusal({ cause: { cause: sdk } })).toBe(true);
    expect(
      isCuaDriverStartupRefusal(
        new Error("embedded cua-driver exited before readiness (code=Some(1))"),
      ),
    ).toBe(false);
  });
});
