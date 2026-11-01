import { describe, expect, it } from "vite-plus/test";

import { parseCommandActions } from "./commandActions.ts";

describe("parseCommandActions", () => {
  it.each([
    ["cat src/app.ts", [{ type: "read", path: "src/app.ts" }]],
    [
      "cat -n a.ts b.ts",
      [
        { type: "read", path: "a.ts" },
        { type: "read", path: "b.ts" },
      ],
    ],
    ["sed -n '1,200p' apps/web/src/main.tsx", [{ type: "read", path: "apps/web/src/main.tsx" }]],
    ["sed -n '40,80p;120,140p' notes.md", [{ type: "read", path: "notes.md" }]],
    ["nl -ba src/index.ts | sed -n '1,80p'", [{ type: "read", path: "src/index.ts" }]],
    ["head -n 40 README.md", [{ type: "read", path: "README.md" }]],
    ["tail -50 server.log", [{ type: "read", path: "server.log" }]],
    ["bat --line-range 10:20 main.rs", [{ type: "read", path: "main.rs" }]],
    ["cd apps/web && cat package.json", [{ type: "read", path: "apps/web/package.json" }]],
    ["/bin/zsh -lc 'cat src/a.ts'", [{ type: "read", path: "src/a.ts" }]],
    ["bash -c \"cat 'My File.md'\"", [{ type: "read", path: "My File.md" }]],
  ] as const)("reads: %s", (command, expected) => {
    expect(parseCommandActions(command)).toEqual(expected);
  });

  it.each([
    ["ls", [{ type: "list" }]],
    ["ls -la apps/web", [{ type: "list", path: "apps/web" }]],
    ["tree -L 2 packages", [{ type: "list", path: "packages" }]],
    ["rg --files src | head -n 50", [{ type: "list", path: "src" }]],
    ["git ls-files packages/shared", [{ type: "list", path: "packages/shared" }]],
    ["find . -maxdepth 2 -type d", [{ type: "list", path: "." }]],
    ["fd", [{ type: "list" }]],
  ] as const)("lists: %s", (command, expected) => {
    expect(parseCommandActions(command)).toEqual(expected);
  });

  it.each([
    [
      "rg -n 'useEffect' apps/web/src",
      [{ type: "search", query: "useEffect", path: "apps/web/src" }],
    ],
    ["rg -e foo -g '*.ts'", [{ type: "search", query: "foo" }]],
    ["rg TODO 2>/dev/null | head -20", [{ type: "search", query: "TODO" }]],
    [
      "grep -rn --include=*.ts parseCommand src",
      [{ type: "search", query: "parseCommand", path: "src" }],
    ],
    ["grep -n needle notes.md", [{ type: "search", query: "needle", path: "notes.md" }]],
    [
      "git grep -n Schema.Union packages",
      [{ type: "search", query: "Schema.Union", path: "packages" }],
    ],
    ["find src -name '*.test.ts'", [{ type: "search", query: "*.test.ts", path: "src" }]],
    [
      "fd -e ts commandLabel packages",
      [{ type: "search", query: "commandLabel", path: "packages" }],
    ],
    [
      "rg -n foo src && cat src/a.ts",
      [
        { type: "search", query: "foo", path: "src" },
        { type: "read", path: "src/a.ts" },
      ],
    ],
  ] as const)("searches: %s", (command, expected) => {
    expect(parseCommandActions(command)).toEqual(expected);
  });

  it.each([
    // Real commands stay terminal rows.
    "git diff",
    "git status --short",
    "vp test run src/a.test.ts",
    "npm install",
    "cd apps/web",
    "echo hi",
    // Anything that can write.
    "sed -i 's/a/b/' file.ts",
    "sed 's/a/b/' file.ts",
    "cat a.ts > b.ts",
    "cat a.ts >> b.ts",
    "cat <<EOF > file.ts",
    "find . -name '*.tmp' -delete",
    "find . -name '*.ts' -exec rm {} \\;",
    "fd -e log -x rm",
    "rg --pre ./run.sh foo",
    "tree -o out.txt",
    "tree -oout.txt",
    "rg foo | xargs rm",
    "ls | tee listing.txt",
    "rg foo | sort -oout.txt",
    "rg foo | uniq - out.txt",
    "ls && rm -rf build",
    "cat a.ts; rm a.ts",
    "sed -n 40,80p;rm notes.md",
    "rg foo | sed 's/a/b/'",
    // Runtime state or control flow we do not model.
    "cat $FILE",
    'cat "$HOME/notes.md"',
    "cat `which foo`",
    "cat $(git ls-files)",
    "tail -f server.log",
    "rg foo || true",
    "cat file &",
    "FOO=1 rg foo",
    "for f in *.ts; do cat $f; done",
    "cat a.ts\nrm a.ts",
    "grep foo",
    "cat",
    "cat 'unterminated",
    "# cat a.ts",
  ])("keeps a plain command: %s", (command) => {
    expect(parseCommandActions(command)).toEqual([]);
  });

  it("drops more actions than a row can show", () => {
    const files = Array.from({ length: 17 }, (_, index) => `f${index}.ts`).join(" ");
    expect(parseCommandActions(`cat ${files}`)).toEqual([]);
  });

  it("keeps commands plain when their actions exceed the wire bounds", () => {
    expect(parseCommandActions(`rg ${"x".repeat(1_025)} src`)).toEqual([]);
    expect(parseCommandActions("ls ''")).toEqual([]);
    expect(parseCommandActions("cat valid.ts && ls ''")).toEqual([]);
    expect(parseCommandActions(`rg ${"x".repeat(1_024)} src`)).toEqual([
      { type: "search", query: "x".repeat(1_024), path: "src" },
    ]);
  });
});
