import { describe, expect, it } from "vite-plus/test";
import {
  workspaceRelativeFilePath,
  isWindowsShellOs,
  msysDrivePathToWindows,
  newProjectFolderName,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
  resolveWorkspaceFilePath,
  toWindowsHostPath,
  windowsHostPathKey,
} from "./path.ts";

describe("Windows host paths", () => {
  it.each([
    ["/c/Users/x", "C:\\Users\\x"],
    ["/C/Users/x/", "C:\\Users\\x"],
    ["/c", "C:\\"],
    ["/c/", "C:\\"],
    ["/cygdrive/d/a b", "D:\\a b"],
    ["/cygdrive/d", "D:\\"],
    ["C:/Users/x", "C:\\Users\\x"],
    ["c:\\Users\\x\\", "C:\\Users\\x"],
    ["C:\\", "C:\\"],
    ["\\\\server\\share", "\\\\server\\share"],
    ["/tmp/x", "/tmp/x"],
    ["/cygdrive", "/cygdrive"],
    ["/cd/x", "/cd/x"],
  ])("toWindowsHostPath(%j) is %j", (input, expected) => {
    expect(toWindowsHostPath(input)).toBe(expected);
  });

  it("recognizes only drive mounts as MSYS drive paths", () => {
    expect(msysDrivePathToWindows("/home/x")).toBeNull();
    expect(msysDrivePathToWindows("C:\\x")).toBeNull();
    expect(msysDrivePathToWindows("relative/c/x")).toBeNull();
  });

  it("keys every shell form of one folder the same", () => {
    const key = windowsHostPathKey("C:\\Users\\Super\\Dev");
    for (const form of ["/c/users/super/dev/", "/cygdrive/C/Users/Super/Dev", "c:/users/super/dev"])
      expect(windowsHostPathKey(form)).toBe(key);
    expect(windowsHostPathKey("D:\\Users\\Super\\Dev")).not.toBe(key);
  });

  it("detects Git Bash, MSYS2, and Cygwin unames", () => {
    expect(isWindowsShellOs("MINGW64_NT-10.0-26200")).toBe(true);
    expect(isWindowsShellOs("MSYS_NT-10.0")).toBe(true);
    expect(isWindowsShellOs("CYGWIN_NT-10.0")).toBe(true);
    expect(isWindowsShellOs("Linux")).toBe(false);
    expect(isWindowsShellOs(null)).toBe(false);
  });
});

describe("path helpers", () => {
  // regression: #17923 literal colons in names are kept, not parsed as positions
  it.each([
    ["report:123", "/workspace", "/workspace/report:123"],
    ["src/file", "C:\\Workspace\\", "C:\\Workspace\\src\\file"],
    ["~/report:123", "/workspace", "~/report:123"],
  ])("resolves literal path %s within %s", (path, root, expected) => {
    expect(resolveWorkspaceFilePath(path, root)).toBe(expected);
  });

  it("normalizes a bare Windows drive root the same as one with a trailing separator", () => {
    expect(normalizeProjectPathForDispatch("C:")).toBe("C:\\");
    expect(normalizeProjectPathForComparison("C:")).toBe("c:\\");
    expect(normalizeProjectPathForComparison("C:")).toBe(normalizeProjectPathForComparison("C:\\"));
    expect(normalizeProjectPathForComparison("C:")).toBe(normalizeProjectPathForComparison("C:/"));
    expect(normalizeProjectPathForDispatch("C:\\repo\\")).toBe("C:\\repo");
  });

  it("names a new project's folder from any typed name", () => {
    expect(newProjectFolderName("Pinball Stats")).toBe("pinball-stats");
    expect(newProjectFolderName("  Café & Crème!  ")).toBe("cafe-creme");
    expect(newProjectFolderName("../../etc")).toBe("etc");
    expect(newProjectFolderName("🎱🎱")).toBe("project");
    expect(newProjectFolderName(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
    expect(newProjectFolderName("Con")).toBe("con-project");
    expect(newProjectFolderName("LPT1")).toBe("lpt1-project");
    expect(newProjectFolderName("console")).toBe("console");
  });
});

describe("workspaceRelativeFilePath", () => {
  // regression: #9309 POSIX paths compare case-sensitively, Windows paths do not
  it.each([
    ["/Repo/Project/src/main.ts", "/repo/project", null],
    ["C:/USERS/mike/t3code/main.ts", "c:/users/MIKE/t3code", "main.ts"],
    ["/repo/project-two/a.ts", "/repo/project", null],
    // regression: #16354 a `..` that leaves the root is a host path, not a workspace path
    ["/repo/project/../other/notes.md", "/repo/project", null],
    ["C:\\repo\\project\\src\\..\\..\\notes.md", "C:\\repo\\project", null],
    ["/repo/project/docs/a/../b.md", "/repo/project", "docs/a/../b.md"],
  ])("relates %s to %s", (path, workspaceRoot, relativePath) => {
    expect(workspaceRelativeFilePath(path, workspaceRoot)).toBe(relativePath);
  });
});
