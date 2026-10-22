import { describe, expect, it } from "@effect/vitest";

import { claudeFileChangePatch, codexFileChangePatch } from "./fileChangePatch.ts";

describe("codexFileChangePatch", () => {
  it("gives every file of one apply_patch its own git section", () => {
    expect(
      codexFileChangePatch([
        { path: "/repo/src/a.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b\n" },
        { path: "/repo/new.md", kind: { type: "add" }, diff: "one\ntwo" },
        { path: "/repo/old.md", kind: { type: "delete" }, diff: "gone\n" },
      ]),
    ).toBe(
      [
        "diff --git a//repo/src/a.ts b//repo/src/a.ts",
        "--- a//repo/src/a.ts",
        "+++ b//repo/src/a.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "diff --git a//repo/new.md b//repo/new.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b//repo/new.md",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
        "\\ No newline at end of file",
        "diff --git a//repo/old.md b//repo/old.md",
        "deleted file mode 100644",
        "--- a//repo/old.md",
        "+++ /dev/null",
        "@@ -1,1 +0,0 @@",
        "-gone",
        "",
      ].join("\n"),
    );
  });

  it("keeps a move and quotes names git would quote", () => {
    const patch = codexFileChangePatch([
      {
        path: "/repo/a\tb.ts",
        kind: { type: "update", move_path: "/repo/c.ts" },
        diff: "",
      },
    ]);
    expect(patch).toBe(
      'diff --git "a//repo/a\\tb.ts" b//repo/c.ts\nsimilarity index 100%\nrename from "/repo/a\\tb.ts"\nrename to /repo/c.ts\n',
    );
  });

  it("offers no patch when an update's diff has no hunk", () => {
    expect(
      codexFileChangePatch([{ path: "/repo/a.ts", kind: { type: "update" }, diff: "binary" }]),
    ).toBeUndefined();
  });

  it("writes paths inside the workspace relative to it, and leaves outsiders absolute", () => {
    const root = "/tmp/goat-rv/localproj";
    expect(
      codexFileChangePatch(
        [
          {
            path: `${root}/a.txt`,
            kind: { type: "update" },
            diff: "@@ -1 +1 @@\n-a\n+b\n",
          },
          {
            path: `${root}/é quoted"name.txt`,
            kind: { type: "add" },
            diff: "x\n",
          },
          {
            path: "/tmp/outside.txt",
            kind: { type: "update" },
            diff: "@@ -1 +1 @@\n-a\n+b\n",
          },
        ],
        root,
      ),
    ).toBe(
      [
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        'diff --git "a/é quoted\\"name.txt" "b/é quoted\\"name.txt"',
        "new file mode 100644",
        "--- /dev/null",
        '+++ "b/é quoted\\"name.txt"',
        "@@ -0,0 +1,1 @@",
        "+x",
        "diff --git a//tmp/outside.txt b//tmp/outside.txt",
        "--- a//tmp/outside.txt",
        "+++ b//tmp/outside.txt",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "",
      ].join("\n"),
    );
  });
});

describe("claudeFileChangePatch", () => {
  it("renders structuredPatch hunks with their real line numbers", () => {
    expect(
      claudeFileChangePatch("/repo/a.ts", {
        filePath: "/repo/a.ts",
        structuredPatch: [
          { oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, lines: [" x", "-a", "+b"] },
        ],
      }),
    ).toBe(
      "diff --git a//repo/a.ts b//repo/a.ts\n--- a//repo/a.ts\n+++ b//repo/a.ts\n@@ -10,2 +10,2 @@\n x\n-a\n+b\n",
    );
  });

  it("renders a created file inside the workspace by its repo-relative name", () => {
    expect(
      claudeFileChangePatch(
        "/tmp/goat-rv/localproj/n.ts",
        { type: "create", filePath: "/tmp/goat-rv/localproj/n.ts", content: "x\n" },
        "/tmp/goat-rv/localproj",
      ),
    ).toBe(
      "diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,1 @@\n+x\n",
    );
  });

  it("renders a created file and skips staged writes", () => {
    expect(
      claudeFileChangePatch("/repo/n.ts", { type: "create", content: "x\n", structuredPatch: [] }),
    ).toBe(
      "diff --git a//repo/n.ts b//repo/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b//repo/n.ts\n@@ -0,0 +1,1 @@\n+x\n",
    );
    expect(
      claudeFileChangePatch("/repo/n.ts", { staged: true, type: "create", content: "x\n" }),
    ).toBeUndefined();
  });
});
