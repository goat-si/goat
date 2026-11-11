// @effect-diagnostics nodeBuiltinImport:off -- Reads the Windows helper's C# sources for safety checks.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  type WindowsReadiness,
  windowsReadinessBlocker,
  windowsReadinessFailure,
} from "./ComputerUseHelperWindows.ts";

const windowsHelperDir = NodePath.join(
  import.meta.dirname,
  "../../native/computer-use-helper-windows",
);

// The helper's answer from a signed-in console session on mini.
const READY: WindowsReadiness = {
  accessibility: true,
  screenRecording: true,
  interactiveSession: true,
  connectState: "active",
  inputDesktop: "Default",
  uiAutomation: true,
  helperElevated: false,
};

describe("Windows computer use readiness", () => {
  it("names each way a desktop is not usable with its own reason, and none when it is", () => {
    assert.isUndefined(windowsReadinessFailure(READY));
    const states: ReadonlyArray<Partial<WindowsReadiness>> = [
      // Session 0, as the helper answers there.
      {
        accessibility: false,
        screenRecording: false,
        interactiveSession: false,
        connectState: "none",
        inputDesktop: "unavailable",
        uiAutomation: false,
        helperElevated: true,
      },
      { helperElevated: true },
      { connectState: "disconnected", screenRecording: false },
      {
        inputDesktop: "Winlogon",
        accessibility: false,
        screenRecording: false,
        uiAutomation: false,
      },
      { uiAutomation: false, accessibility: false },
      { connectState: "connected", screenRecording: false },
    ];
    const reasons = states.map((state) => windowsReadinessFailure({ ...READY, ...state }));
    for (const reason of reasons) assert.isString(reason);
    assert.equal(new Set(reasons).size, states.length);
    assert.match(reasons[0] ?? "", /Session 0/);
    assert.match(reasons[3] ?? "", /locked/);
    // The typed cause names the same failure as the reason, and only where one fits.
    assert.deepEqual(
      states.map((state) => windowsReadinessBlocker({ ...READY, ...state })),
      [
        "noInteractiveDesktop",
        undefined,
        "noInteractiveDesktop",
        "screenLocked",
        undefined,
        undefined,
      ],
    );
    assert.isUndefined(
      windowsReadinessBlocker({ ...READY, helperElevated: true, connectState: "disconnected" }),
    );
    assert.isUndefined(windowsReadinessBlocker(READY));
  });

  it("refuses protected Windows system, credential, security and desktop shell surfaces in WindowsFacts and FrameSource", () => {
    const factsSource = NodeFS.readFileSync(
      NodePath.join(windowsHelperDir, "WindowsFacts.cs"),
      "utf8",
    );
    const frameSource = NodeFS.readFileSync(
      NodePath.join(windowsHelperDir, "FrameSource.cs"),
      "utf8",
    );

    const procMatch = factsSource.match(/ProtectedProcesses\s*=\s*\{([\s\S]*?)\};/);
    const classMatch = factsSource.match(/ProtectedWindowClasses\s*=\s*\{([\s\S]*?)\};/);
    assert.isNotNull(procMatch, "WindowsFacts.cs must declare ProtectedProcesses");
    assert.isNotNull(classMatch, "WindowsFacts.cs must declare ProtectedWindowClasses");

    const extractStrings = (block: string) =>
      Array.from(block.matchAll(/"([^"]+)"/g), (m) => m[1]!);
    const protectedProcesses = extractStrings(procMatch?.[1] ?? "");
    const protectedClasses = extractStrings(classMatch?.[1] ?? "");

    assert.deepEqual(protectedProcesses, [
      "consent.exe",
      "logonui.exe",
      "winlogon.exe",
      "credentialuibroker.exe",
      "lockapp.exe",
      "lsass.exe",
      "securityhealthhost.exe",
      "securityhealthsystray.exe",
    ]);
    assert.deepEqual(protectedClasses, [
      "Progman",
      "WorkerW",
      "Shell_TrayWnd",
      "Shell_SecondaryTrayWnd",
    ]);

    // Mirror the pure C# ExecutableName + ProtectedSurfaceRefusal rules and verify all cases.
    const executableName = (imagePathOrName: string | null | undefined): string => {
      if (!imagePathOrName) return "";
      const trimmed = imagePathOrName.trim();
      const slash = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
      return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
    };
    const isProtectedProcess = (imagePathOrName: string | null | undefined): boolean => {
      const exe = executableName(imagePathOrName).toLowerCase();
      return exe.length > 0 && protectedProcesses.some((p) => p.toLowerCase() === exe);
    };
    const isProtectedWindowClass = (className: string | null | undefined): boolean => {
      if (!className) return false;
      const trimmed = className.trim().toLowerCase();
      return trimmed.length > 0 && protectedClasses.some((c) => c.toLowerCase() === trimmed);
    };
    const protectedSurfaceRefusal = (
      imagePathOrName: string | null | undefined,
      className: string | null | undefined,
    ): string | null => {
      if (isProtectedProcess(imagePathOrName))
        return `Protected system process ${executableName(imagePathOrName)} cannot be observed or controlled.`;
      if (isProtectedWindowClass(className))
        return `Protected shell surface ${className!.trim()} cannot be observed or controlled.`;
      return null;
    };

    for (const proc of protectedProcesses) {
      assert.isTrue(isProtectedProcess(proc));
      assert.isTrue(isProtectedProcess(`C:\\Windows\\System32\\${proc.toUpperCase()}`));
      assert.include(
        protectedSurfaceRefusal(`C:\\Windows\\System32\\${proc}`, "DirectUIHWND") ?? "",
        proc,
      );
    }
    for (const cls of protectedClasses) {
      assert.isTrue(isProtectedWindowClass(cls));
      assert.isTrue(isProtectedWindowClass(cls.toLowerCase()));
      assert.include(protectedSurfaceRefusal("C:\\Windows\\explorer.exe", cls) ?? "", cls);
    }
    assert.isNull(protectedSurfaceRefusal("C:\\Windows\\System32\\notepad.exe", "Notepad"));
    assert.isNull(protectedSurfaceRefusal(null, ""));

    // Verify WindowsFacts.Window and FrameSource.Capture / FrameSource.Admission wire the checks.
    assert.match(factsSource, /result\["protectedSurface"\]\s*=\s*protectedRefusal != null;/);
    assert.match(
      factsSource,
      /result\["elevatedTarget"\]\s*=\s*targetIntegrity < 0 \|\| targetIntegrity > own \|\| protectedRefusal != null;/,
    );
    assert.match(frameSource, /WindowsFacts\.IsProtectedWindow\(window,\s*pid\)/);
    const admissionMatches =
      frameSource.match(/WindowsFacts\.IsProtectedWindow\(window,\s*pid\)/g) ?? [];
    assert.isAtLeast(
      admissionMatches.length,
      2,
      "FrameSource.cs must check WindowsFacts.IsProtectedWindow in both Capture and Admission",
    );
  });

  it("stamps each Windows frame with the time its capture began, as the macOS helper does", () => {
    // DesktopFrames pairs the cursor and reports ageMs only for a stamped frame.
    const frameSource = NodeFS.readFileSync(
      NodePath.join(windowsHelperDir, "FrameSource.cs"),
      "utf8",
    );
    const capture = frameSource.slice(frameSource.indexOf("Dictionary<string, object> Capture("));
    const stamp = capture.search(
      /long capturedAt = DateTimeOffset\.UtcNow\.ToUnixTimeMilliseconds\(\);/,
    );
    assert.isAtLeast(stamp, 0, "Capture must read the wall clock in Unix milliseconds");
    assert.isBelow(stamp, capture.indexOf("CaptureGuard.CaptureNative("));
    assert.match(capture, /frame\["capturedAt"\] = capturedAt;/);
  });
});

// oxlint-disable-next-line goat/no-global-process-runtime -- Compiling the helper's C# needs the real host: csc on Windows, dotnet elsewhere.
const compilesOnWindows = process.platform === "win32";

if (compilesOnWindows || process.env.GOAT_TEST_DOTNET === "1") {
  it("treats a renewed Artifact Signing certificate as the same publisher, and nothing broader", () => {
    const temp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-signing-identity-"));
    try {
      const source = NodePath.join(windowsHelperDir, "SigningIdentity.cs");
      const fixture = NodePath.join(import.meta.dirname, "SigningIdentityTest.cs");
      let output: string;
      if (compilesOnWindows) {
        const executable = NodePath.join(temp, "test.exe");
        const compiler = NodePath.join(
          process.env.WINDIR ?? "C:\\Windows",
          "Microsoft.NET",
          "Framework64",
          "v4.0.30319",
          "csc.exe",
        );
        NodeChildProcess.execFileSync(compiler, [
          "/nologo",
          "/warnaserror+",
          `/out:${executable}`,
          source,
          fixture,
        ]);
        output = NodeChildProcess.execFileSync(executable, { encoding: "utf8" });
      } else {
        const version = NodeChildProcess.execFileSync("dotnet", ["--version"], {
          encoding: "utf8",
        });
        const major = Number.parseInt(version, 10);
        const project = NodePath.join(temp, "test.csproj");
        NodeFS.copyFileSync(source, NodePath.join(temp, "SigningIdentity.cs"));
        NodeFS.copyFileSync(fixture, NodePath.join(temp, "SigningIdentityTest.cs"));
        NodeFS.writeFileSync(
          project,
          `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net${major}.0</TargetFramework></PropertyGroup></Project>`,
        );
        output = NodeChildProcess.execFileSync("dotnet", ["run", "--project", project], {
          encoding: "utf8",
        });
      }
      assert.include(output, "Signing identity cases passed");
    } finally {
      NodeFS.rmSync(temp, { recursive: true, force: true });
    }
  });
}
