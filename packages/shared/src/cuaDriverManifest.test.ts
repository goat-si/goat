// @effect-diagnostics nodeBuiltinImport:off -- A trap driver script on a real temporary directory proves what runs.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import * as HostProcess from "./HostProcess.ts";

import {
  CUA_DRIVER_ALLOWED_TOOLS,
  CUA_DRIVER_EXCLUDED_TOOLS,
  admittedCuaApplications,
  cuaRequestableApps,
  cuaDriverCapabilityManifest,
  cuaDriverManifestApplications,
  missingCuaDriverApplications,
  isCuaDriverStartupRefusal,
  prepareCuaDriverCapabilityManifest,
  writeCuaDriverCapabilityManifest,
} from "./cuaDriverManifest.ts";

vi.mock("node:fs/promises", { spy: true });

describe("cuaDriverManifest", () => {
  it("retains every attested identity when a best-effort listing loses the bundle id", () => {
    const apps = cuaRequestableApps(
      [{ name: " Editor.exe ", executable: " C:\\Apps\\Editor.exe " }],
      [],
    );
    expect(apps).toEqual(["C:\\Apps\\Editor.exe", "Editor.exe"]);
    expect(apps).not.toContain("Editor window");
  });

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

  it("offers only list_apps identities outside the manifest's protected apps", () => {
    expect(
      cuaRequestableApps(
        [
          { bundle_id: " com.apple.TextEdit ", name: "Editor window" },
          { bundle_id: "com.apple.TextEdit", name: "Duplicate" },
          { bundle_id: " ", name: " fixture.exe ", executable: "C:\\Apps\\fixture.exe" },
          { name: "Linux Editor", executable: "/usr/bin/editor" },
          { name: "Name only" },
          { bundle_id: "SI.GOAT.DESKTOP", name: "GOAT" },
          { name: "GOAT.exe", executable: "c:/Program Files/GOAT/GOAT.exe" },
          { bundle_id: "com.trycua.driver", name: "Driver" },
          { bundle_id: "com.apple.Passwords", name: "Vault" },
          { bundle_id: "org.example.vault", name: "Bitwarden" },
          { name: "1Password.exe" },
          { name: "Driver", executable: "C:\\Tools\\cua-driver.exe" },
          {
            bundle_id: "org.example.host",
            name: "Host alias",
            executable: "C:\\Program Files\\GOAT\\GOAT.exe",
          },
          {
            bundle_id: "org.example.vault",
            name: "Vault alias",
            executable: "C:\\Apps\\1Password.exe",
          },
          { bundle_id: "com.example.Passwords", name: "Vault" },
          { name: " ", executable: "/usr/bin/anonymous" },
          {},
        ],
        ["si.goat.desktop", "\\\\?\\C:\\Program Files\\GOAT\\GOAT.exe"],
      ),
    ).toEqual([
      "/usr/bin/anonymous",
      "/usr/bin/editor",
      "C:\\Apps\\fixture.exe",
      "Linux Editor",
      "Name only",
      "com.apple.TextEdit",
      "fixture.exe",
    ]);
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

  it("admits a running Linux app with no desktop entry by its executable, one entry per path (#1513)", () => {
    expect(
      admittedCuaApplications(
        [
          { bundle_id: "org.gnome.Calculator", name: "Calculator" },
          { bundle_id: null, name: "python3", executable: "/usr/bin/python3.12" },
          { bundle_id: null, name: "fixture.py", executable: "/usr/bin/python3.12" },
          { bundle_id: null, name: "cua-driver", executable: "/opt/goat/cua-driver/cua-driver" },
          { bundle_id: null, name: "keepassxc", executable: "/usr/bin/keepassxc" },
          { bundle_id: null, name: "node", executable: "/usr/bin/node" },
        ],
        ["/usr/bin/node"],
      ),
    ).toEqual([
      { executable: "/usr/bin/python3.12", names: ["fixture.py", "python3"] },
      "org.gnome.Calculator",
    ]);
  });

  it("writes a Linux executable grant the driver matches, and reads back the names approvals use (#1513)", () => {
    const text = cuaDriverCapabilityManifest({
      applications: [
        "org.gnome.Calculator",
        { executable: "/usr/bin/python3.12", names: ["python3"] },
      ],
      tools: ["list_apps"],
    });
    expect(text).toContain('    - executable: "/usr/bin/python3.12" # names: ["python3"]');
    expect(cuaDriverManifestApplications(text)).toEqual([
      "org.gnome.Calculator",
      "/usr/bin/python3.12",
      "python3",
    ]);
    expect(
      missingCuaDriverApplications(["python3", "gedit"], cuaDriverManifestApplications(text)),
    ).toEqual(["gedit"]);
  });

  it.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "reads a windowed Linux app's executable from /proc, never GOAT's own process or a windowless one (#1513)",
    async () => {
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-manifest-"));
      const child = (await import("node:child_process")).spawn("sleep", ["30"], {
        stdio: "ignore",
      });
      try {
        const pid = child.pid ?? 0;
        const path = await prepareCuaDriverCapabilityManifest({
          binaryPath: "/nonexistent/cua-driver",
          platform: "linux",
          environment: {},
          hostBundleIds: [],
          path: NodePath.join(directory, "manifest.yaml"),
          listApplications: async () => [
            { bundle_id: null, name: "sleep", pid, windows: [{ window_id: 1 }] },
            { bundle_id: null, name: "windowless", pid, windows: [] },
            { bundle_id: null, name: "goat", pid: process.pid, windows: [{ window_id: 2 }] },
          ],
        });
        const text = await NodeFSP.readFile(path, "utf8");
        const sleep = await NodeFSP.realpath(`/proc/${pid}/exe`);
        expect(text).toContain(`    - executable: ${JSON.stringify(sleep)} # names: ["sleep"]`);
        expect(text).not.toContain("windowless");
        expect(text).not.toContain(JSON.stringify(await NodeFSP.realpath(process.execPath)));
      } finally {
        child.kill();
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    },
  );

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

  it("reads JSON-quoted app ids without confusing tools or escaped characters", () => {
    const applications = ['com.example."quoted"', "C:\\Apps\\notes.exe", "com.example.\nline"];
    expect(cuaDriverManifestApplications(cuaDriverCapabilityManifest({ applications }))).toEqual(
      applications,
    );
    expect(
      cuaDriverManifestApplications(cuaDriverCapabilityManifest({ applications: [] })),
    ).toEqual([]);
    expect(() => cuaDriverManifestApplications("    - bundle_id: invalid")).toThrow();
  });

  it("finds missing approvals using the same bundle and Windows path identities as admission", () => {
    const listed = ["com.apple.TextEdit", "C:\\Apps\\notes.exe", "\\\\server\\share\\app.exe"];
    expect(
      missingCuaDriverApplications(
        [
          "COM.APPLE.TEXTEDIT",
          "\\\\?\\C:\\Apps\\notes.exe",
          "c:/apps//NOTES.exe",
          "\\\\?\\UNC\\server\\share\\APP.exe",
          "com.example.new",
          "C:\\Apps\\new.exe",
        ],
        listed,
      ),
    ).toEqual(["com.example.new", "C:\\Apps\\new.exe"]);
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
  /**
   * A stand-in driver that only leaves a mark when something runs it. The driver is spawned
   * without a shell, so the stand-in is this Node binary with a preload that marks and exits:
   * a script with a shebang would not run on Windows (#1378).
   */
  const trap = (onTestFinished: (cleanup: () => void) => void) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-cu-manifest-"));
    onTestFinished(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
    const marker = NodePath.join(directory, "ran");
    const preload = NodePath.join(directory, "cua-driver");
    NodeFS.writeFileSync(
      preload,
      "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", '');\nprocess.exit(3);\n",
    );
    return {
      ran: () => NodeFS.existsSync(marker),
      input: {
        binaryPath: process.execPath,
        platform: "darwin" as const,
        // NODE_OPTIONS reads a backslash inside quotes as an escape, so the path uses slashes.
        environment: {
          PATH: "/usr/bin:/bin",
          NODE_OPTIONS: "--require " + JSON.stringify(preload.replaceAll("\\", "/")),
        },
        hostBundleIds: ["si.goat.desktop"],
        path: NodePath.join(directory, "manifest.yaml"),
      },
    };
  };

  it("keeps the previous manifest readable until the complete replacement is ready", async ({
    onTestFinished,
  }) => {
    const driver = trap(onTestFinished);
    const before = cuaDriverCapabilityManifest({ applications: ["com.example.before"] });
    const after = cuaDriverCapabilityManifest({ applications: ["com.example.after"] });
    await writeCuaDriverCapabilityManifest(driver.input.path, before);
    const written = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { writeFile: original } = await vi.importActual<typeof NodeFSP>("node:fs/promises");
    using _write = vi
      .spyOn(NodeFSP, "writeFile")
      .mockImplementation(async (path, text, options) => {
        await original(path, text, options);
        written.resolve();
        await release.promise;
      });
    const replacing = writeCuaDriverCapabilityManifest(driver.input.path, after);
    try {
      await written.promise;
      expect(NodeFS.readFileSync(driver.input.path, "utf8")).toBe(before);
    } finally {
      release.resolve();
      await replacing;
    }
    expect(NodeFS.readFileSync(driver.input.path, "utf8")).toBe(after);
    expect(NodeFS.readdirSync(NodePath.dirname(driver.input.path)).sort()).toEqual([
      "cua-driver",
      "manifest.yaml",
    ]);
    if (HostProcess.Platform.defaultValue() !== "win32")
      expect(NodeFS.statSync(driver.input.path).mode & 0o777).toBe(0o600);
  });

  it("preserves the previous manifest and cleans up when replacement is refused", async ({
    onTestFinished,
  }) => {
    const driver = trap(onTestFinished);
    const before = cuaDriverCapabilityManifest({ applications: ["com.example.before"] });
    await writeCuaDriverCapabilityManifest(driver.input.path, before);
    const denied = new Error("rename denied");
    using _rename = vi.spyOn(NodeFSP, "rename").mockRejectedValueOnce(denied);
    await expect(writeCuaDriverCapabilityManifest(driver.input.path, "replacement")).rejects.toBe(
      denied,
    );
    expect(NodeFS.readFileSync(driver.input.path, "utf8")).toBe(before);
    expect(NodeFS.readdirSync(NodePath.dirname(driver.input.path)).sort()).toEqual([
      "cua-driver",
      "manifest.yaml",
    ]);
  });

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
