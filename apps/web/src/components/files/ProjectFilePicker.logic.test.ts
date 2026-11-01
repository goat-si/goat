import { assert, describe, it } from "vite-plus/test";

import {
  getProjectFilePickerMatches,
  isProjectFilePickerPathQuery,
  projectFilePickerWorkspacePath,
  resolveProjectFilePickerPath,
} from "./ProjectFilePicker.logic";

function pathsForQuery(entries: Parameters<typeof getProjectFilePickerMatches>[0], query: string) {
  return getProjectFilePickerMatches(entries, query).map(({ name, path }) => ({ name, path }));
}

const entries = [
  { kind: "directory", path: "apps/web/src" },
  { kind: "file", path: "apps/web/src/index.ts" },
  { kind: "file", path: "packages/shared/src/index.ts" },
  { kind: "file", path: "README.md" },
  { kind: "file", path: ".gitignore" },
] as const;

describe("getProjectFilePickerMatches", () => {
  it("preserves the server result order", () => {
    assert.deepEqual(pathsForQuery(entries, "index"), [
      { name: "src", path: "apps/web/src" },
      { name: "index.ts", path: "apps/web/src/index.ts" },
      { name: "index.ts", path: "packages/shared/src/index.ts" },
      { name: "README.md", path: "README.md" },
      { name: ".gitignore", path: ".gitignore" },
    ]);
  });

  it("includes directory results alongside files for a nonempty query", () => {
    assert.deepEqual(pathsForQuery(entries.slice(0, 2), "src"), [
      { name: "src", path: "apps/web/src" },
      { name: "index.ts", path: "apps/web/src/index.ts" },
    ]);
  });

  it("supports space-separated path tokens and a result limit", () => {
    assert.deepEqual(
      getProjectFilePickerMatches(entries, "src index", 1).map(({ name, path }) => ({
        name,
        path,
      })),
      [{ name: "src", path: "apps/web/src" }],
    );
  });

  it("matches ordered characters while allowing skipped characters", () => {
    const fuzzyEntries = [
      { kind: "file", path: "src/TestFlags.tsx" },
      { kind: "file", path: "src/SubtestFlow.tsx" },
      { kind: "file", path: "src/useSubtestFlags.ts" },
      {
        kind: "file",
        path: "src/useSubtestFlags/useTabActivity.ts",
      },
    ] as const;

    assert.deepEqual(
      pathsForQuery(fuzzyEntries, "testf").map(({ name }) => name),
      ["TestFlags.tsx", "SubtestFlow.tsx", "useSubtestFlags.ts", "useTabActivity.ts"],
    );
    assert.deepEqual(getProjectFilePickerMatches(fuzzyEntries, "tsfl")[0], {
      kind: "file",
      name: "TestFlags.tsx",
      nameMatchIndices: [0, 2, 4, 5],
      path: "src/TestFlags.tsx",
      pathMatchIndices: [4, 6, 8, 9],
    });
  });

  it("normalizes path prefixes consistently with server search", () => {
    assert.deepEqual(
      getProjectFilePickerMatches([{ kind: "file", path: "src/index.ts" }], "@/src")[0]
        ?.pathMatchIndices,
      [0, 1, 2],
    );
  });
});

describe("explicit picker paths", () => {
  it("preserves literal POSIX backslashes when converting workspace paths", () => {
    for (const platform of ["linux", "darwin"]) {
      assert.equal(
        projectFilePickerWorkspacePath("/work/repo/a\\b.ts", "/work/repo", platform),
        "a\\b.ts",
      );
      assert.equal(projectFilePickerWorkspacePath("a\\b.ts", "/work/repo", platform), "a\\b.ts");
      assert.equal(
        projectFilePickerWorkspacePath("/work/repo\\other/a.ts", "/work/repo", platform),
        "/work/repo\\other/a.ts",
      );
    }
    assert.equal(
      projectFilePickerWorkspacePath("C:\\repo\\a\\b.ts", "c:/repo", "windows"),
      "a/b.ts",
    );
  });

  it("detects paths using the destination platform", () => {
    for (const platform of ["darwin", "linux"]) {
      for (const query of ["/", " /srv/app/file.ts:42:3 ", "~/notes/", "/tmp/a\\b"]) {
        assert.isTrue(isProjectFilePickerPathQuery(query, platform), query);
      }
      for (const query of ["C:\\work\\file.ts", "C:/work/", "\\\\host\\share\\", "~\\notes"]) {
        assert.isFalse(isProjectFilePickerPathQuery(query, platform), query);
      }
    }
    for (const query of [
      "C:\\",
      "C:/work/file.ts:42",
      "\\\\host\\share\\",
      "~/notes",
      "~\\notes",
    ]) {
      assert.isTrue(isProjectFilePickerPathQuery(query, "windows"), query);
    }
    for (const query of ["C:", "C:relative", "src/app.ts", "./src/", "~", "", "   "]) {
      assert.isFalse(isProjectFilePickerPathQuery(query, "windows"), query);
      assert.isFalse(isProjectFilePickerPathQuery(query, "linux"), query);
    }
  });

  it("expands a custom remote home rather than inferring it from the workspace", () => {
    assert.deepEqual(
      resolveProjectFilePickerPath("~/notes/a.ts:42:3", "linux", "/srv/remote-user"),
      {
        path: "/srv/remote-user/notes/a.ts",
        line: 42,
        column: 3,
        directoryOnly: false,
      },
    );
    assert.deepEqual(resolveProjectFilePickerPath("~\\notes\\a.ts:12", "windows", "D:\\Remote"), {
      path: "D:\\Remote\\notes\\a.ts",
      line: 12,
      directoryOnly: false,
    });
    assert.isNull(resolveProjectFilePickerPath("~/notes/a.ts", "linux", null));
    assert.isNull(resolveProjectFilePickerPath("src/a.ts", "linux", "/srv/remote-user"));
  });

  it("preserves directory intent and filesystem roots", () => {
    for (const [query, platform, path] of [
      ["/", "linux", "/"],
      ["/srv/app///", "linux", "/srv/app"],
      ["C:\\", "windows", "C:\\"],
      ["C:/work/", "windows", "C:\\work"],
      ["\\\\host\\share\\", "windows", "\\\\host\\share\\"],
    ] as const) {
      assert.deepEqual(resolveProjectFilePickerPath(query, platform, null), {
        path,
        directoryOnly: true,
      });
    }
    assert.deepEqual(resolveProjectFilePickerPath("~/", "linux", "/srv/remote-user"), {
      path: "/srv/remote-user",
      directoryOnly: true,
    });
  });

  it("normalizes dot segments before workspace containment and preserves POSIX backslashes", () => {
    assert.deepEqual(resolveProjectFilePickerPath("/repo/../outside/a.ts", "linux", null), {
      path: "/outside/a.ts",
      directoryOnly: false,
    });
    assert.deepEqual(resolveProjectFilePickerPath("/repo/a\\b.ts", "linux", null), {
      path: "/repo/a\\b.ts",
      directoryOnly: false,
    });
    assert.deepEqual(resolveProjectFilePickerPath("D:/repo/../outside/a.ts", "windows", null), {
      path: "D:\\outside\\a.ts",
      directoryOnly: false,
    });
  });
});
