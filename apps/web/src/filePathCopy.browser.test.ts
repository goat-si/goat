import { stubGlobal } from "../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("./components/ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("./rightPanelStore", () => ({ useRightPanelStore: {} }));

import { copyFilePath, resolveFilePathCopyTargets } from "./filePathCopy";

function setup() {
  state.toast.mockReset();
}

describe("file path copy targets", () => {
  it("preserves spaces", () => {
    expect(
      resolveFilePathCopyTargets({
        filePath: "src/my file.ts",
        workspaceRoot: "/remote/my project",
      }),
    ).toEqual({ relativePath: "src/my file.ts", fullPath: "/remote/my project/src/my file.ts" });
  });

  it.each(["logs/build:2026", "logs/build:0012:0003", "logs/build:0"])(
    "preserves the literal tree and preview header path %s",
    (filePath) => {
      expect(resolveFilePathCopyTargets({ filePath, workspaceRoot: "/remote/my project" })).toEqual(
        { relativePath: filePath, fullPath: `/remote/my project/${filePath}` },
      );
    },
  );

  it("resolves repository-relative diff paths against the repository, not the nested workspace", () => {
    expect(
      resolveFilePathCopyTargets({
        filePath: "packages/app/src/my file.ts",
        workspaceRoot: "/repo/packages/app",
        repositoryRoot: "/repo",
      }),
    ).toEqual({ relativePath: "src/my file.ts", fullPath: "/repo/packages/app/src/my file.ts" });
  });

  it("offers only a full path for host files outside the workspace", () => {
    expect(
      resolveFilePathCopyTargets({
        filePath: "/tmp/my file.ts",
        workspaceRoot: "/repo",
      }),
    ).toEqual({ relativePath: null, fullPath: "/tmp/my file.ts" });
  });

  it("copies a diff outside the nested workspace without offering an editor target", () => {
    expect(
      resolveFilePathCopyTargets({
        filePath: "other/file.ts",
        workspaceRoot: "/repo/packages/app",
        repositoryRoot: "/repo",
      }),
    ).toEqual({ relativePath: null, fullPath: "/repo/other/file.ts" });
  });

  it("does not invent a full path when the host root is unknown", () => {
    expect(
      resolveFilePathCopyTargets({
        filePath: "src/my file.ts",
        workspaceRoot: undefined,
      }),
    ).toEqual({ relativePath: "src/my file.ts", fullPath: null });
  });

  it("preserves Windows drive paths and computes workspace-relative paths", () => {
    expect(
      resolveFilePathCopyTargets({
        filePath: "C:\\repo\\my file.ts",
        workspaceRoot: "C:\\repo",
      }),
    ).toEqual({ relativePath: "my file.ts", fullPath: "C:\\repo\\my file.ts" });
  });
});

describe("copyFilePath", () => {
  it.each([
    ["logs/build:2026", "Relative path"],
    ["/remote/my project/logs/build:2026", "Full path"],
  ] as const)("copies the literal path %s unchanged", async (path, kind) => {
    setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    using _navigator = stubGlobal("navigator", { clipboard: { writeText } });
    await copyFilePath(path, kind);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(path);
    expect(state.toast).toHaveBeenCalledWith({
      type: "success",
      title: `${kind} copied`,
      description: path,
    });
  });

  it.each(["absent", "rejected"] as const)(
    "uses the fallback when the Clipboard API is %s",
    async (api) => {
      setup();
      const writeText = vi.fn().mockRejectedValue(new Error("Document is not focused"));
      using _navigator = stubGlobal(
        "navigator",
        api === "absent" ? {} : { clipboard: { writeText } },
      );
      const copied: string[] = [];
      const execCommand = vi.fn(() => {
        copied.push((document.activeElement as HTMLTextAreaElement).value);
        return true;
      });
      Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
      try {
        await copyFilePath("/remote/my project/logs/build:2026", "Full path");
        expect(copied).toEqual(["/remote/my project/logs/build:2026"]);
        expect(execCommand).toHaveBeenCalledWith("copy");
        expect(document.querySelector("textarea")).toBeNull();
        expect(state.toast).toHaveBeenCalledWith({
          type: "success",
          title: "Full path copied",
          description: "/remote/my project/logs/build:2026",
        });
      } finally {
        Reflect.deleteProperty(document, "execCommand");
      }
    },
  );

  it("reports failure without claiming a copy when both methods fail", async () => {
    setup();
    using _navigator = stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    try {
      await copyFilePath("src/my file.ts", "Relative path");
      expect(state.toast).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          type: "error",
          title: "Failed to copy relative path",
        }),
      );
      expect(document.querySelector("textarea")).toBeNull();
    } finally {
      Reflect.deleteProperty(document, "execCommand");
    }
  });
});
