// @effect-diagnostics nodeBuiltinImport:off -- A trap driver script on a real temporary directory proves what runs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  CUA_DRIVER_ALLOWED_TOOLS,
  CUA_DRIVER_EXCLUDED_TOOLS,
  admittedCuaApplications,
  cuaDriverCapabilityManifest,
  isCuaDriverStartupRefusal,
  prepareCuaDriverCapabilityManifest,
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
      // A whole-display screenshot shows every other app (#1321).
      "get_desktop_state",
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

  it("admits a running Windows program with no bundle id by its executable, never GOAT's own (#1368)", () => {
    const goat = "C:\\Program Files\\GOAT\\GOAT.exe";
    expect(
      admittedCuaApplications(
        [
          // A Start menu app: the driver gives its path as the bundle id.
          {
            bundle_id: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            name: "Google Chrome",
          },
          // Running with no Start menu entry: only the helper's executable identifies it.
          { bundle_id: null, name: "fixture.exe", executable: "C:\\work\\fixture.exe" },
          { bundle_id: null, name: "GOAT.exe", executable: goat },
          {
            bundle_id: null,
            name: "cua-driver.exe",
            executable: "C:\\GOAT\\cua-driver\\cua-driver.exe",
          },
          {
            bundle_id: null,
            name: "GOAT Computer Use.exe",
            executable: "C:\\GOAT\\GOAT Computer Use.exe",
          },
          {
            bundle_id: null,
            name: "KeePassXC.exe",
            executable: "C:\\Apps\\KeePassXC\\KeePassXC.exe",
          },
          { bundle_id: null, name: "explorer.exe" },
        ],
        [goat.toUpperCase()],
      ),
    ).toEqual([
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\work\\fixture.exe",
    ]);
  });

  it("keeps GOAT out however its own path is spelled: prefixed, UNC, forward slashes or case", () => {
    const listed = [
      { bundle_id: null, name: "GOAT.exe", executable: "C:\\Apps\\GOAT\\GOAT.exe" },
      { bundle_id: null, name: "GOAT.exe", executable: "\\\\server\\share\\GOAT\\GOAT.exe" },
      { bundle_id: null, name: "notes.exe", executable: "C:\\Apps\\notes.exe" },
    ];
    for (const host of [
      ["\\\\?\\C:\\Apps\\GOAT\\GOAT.exe", "\\\\?\\UNC\\server\\share\\GOAT\\GOAT.exe"],
      ["c:/apps//goat/GOAT.EXE", "//SERVER/share/goat/goat.exe"],
    ])
      expect(admittedCuaApplications(listed, host)).toEqual(["C:\\Apps\\notes.exe"]);
  });

  it("writes a v3 manifest: tools, display, admitted apps and no file or profile scope", () => {
    const text = cuaDriverCapabilityManifest({
      applications: ['com.example."quoted"'],
      tools: ["list_apps", "click"],
    });
    expect(text).toBe(
      [
        "# Written by GOAT at each driver start. See ADR-0022.",
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

describe("cuaDriverManifest app listing", () => {
  /** A stand-in driver that only leaves a mark when something runs it. */
  const trap = (onTestFinished: (cleanup: () => void) => void) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-cu-manifest-"));
    onTestFinished(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
    const marker = NodePath.join(directory, "ran");
    const binaryPath = NodePath.join(directory, "cua-driver");
    NodeFS.writeFileSync(binaryPath, "#!/bin/sh\ntouch '" + marker + "'\nexit 3\n", {
      mode: 0o755,
    });
    return {
      ran: () => NodeFS.existsSync(marker),
      input: {
        binaryPath,
        platform: "darwin" as const,
        environment: { PATH: "/usr/bin:/bin" },
        hostBundleIds: ["si.goat.desktop"],
        path: NodePath.join(directory, "manifest.yaml"),
      },
    };
  };

  it("lists through the hook and never runs the driver itself", async ({ onTestFinished }) => {
    const driver = trap(onTestFinished);
    const path = await prepareCuaDriverCapabilityManifest({
      ...driver.input,
      listApplications: async () => [
        { bundle_id: "com.apple.TextEdit", name: "TextEdit" },
        { bundle_id: "si.goat.desktop", name: "GOAT" },
      ],
    });
    expect(driver.ran()).toBe(false);
    const manifest = NodeFS.readFileSync(path, "utf8");
    expect(manifest).toContain("com.apple.TextEdit");
    expect(manifest).not.toContain("si.goat.desktop");
  });

  it("fails when the hook fails, without falling back to running the driver", async ({
    onTestFinished,
  }) => {
    const driver = trap(onTestFinished);
    await expect(
      prepareCuaDriverCapabilityManifest({
        ...driver.input,
        listApplications: async () => {
          throw new Error("driver_untrusted");
        },
      }),
    ).rejects.toThrow("driver_untrusted");
    expect(driver.ran()).toBe(false);
  });

  it("runs the driver itself when no hook is given", async ({ onTestFinished }) => {
    const driver = trap(onTestFinished);
    await expect(prepareCuaDriverCapabilityManifest(driver.input)).rejects.toThrow();
    expect(driver.ran()).toBe(true);
  });
});
