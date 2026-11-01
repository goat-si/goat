import { describe, expect, it } from "vite-plus/test";

import { codexCommandActions } from "./CodexCommandActions.ts";

describe("codexCommandActions", () => {
  it("keeps Codex's read, list, and search steps", () => {
    expect(
      codexCommandActions([
        { type: "search", command: "rg -n foo src", query: "foo", path: "src" },
        { type: "read", command: "sed -n 1,80p src/a.ts", name: "a.ts", path: "/repo/src/a.ts" },
        { type: "listFiles", command: "ls", path: null },
      ]),
    ).toEqual([
      { type: "search", query: "foo", path: "src" },
      { type: "read", path: "/repo/src/a.ts" },
      { type: "list" },
    ]);
  });

  it("marks a command with any unknown step as a plain command", () => {
    expect(
      codexCommandActions([
        { type: "read", command: "cat a.ts", name: "a.ts", path: "a.ts" },
        { type: "unknown", command: "vp test run" },
      ]),
    ).toEqual([]);
    expect(codexCommandActions([])).toEqual([]);
  });

  it.each(["src", "src/", "dist", "dist/"])(
    "recovers explicit list and search targets ending in %s",
    (target) => {
      const path = `/tmp/demo/${target}`;
      expect(
        codexCommandActions([
          { type: "listFiles", command: `ls ${path}`, path: "demo" },
          { type: "search", command: `rg -n TODO ${path}`, query: "TODO", path: "demo" },
        ]),
      ).toEqual([
        { type: "list", path },
        { type: "search", query: "TODO", path },
      ]);
    },
  );

  it("keeps Codex metadata when commands cannot identify a single matching action", () => {
    expect(
      codexCommandActions([
        { type: "listFiles", command: "custom-list /tmp/demo/src", path: "demo" },
        {
          type: "search",
          command: "custom-search TODO /tmp/demo/dist",
          query: "TODO",
          path: "demo",
        },
        { type: "listFiles", command: "rg TODO /tmp/demo/src", path: "demo" },
        { type: "search", command: "ls /tmp/demo/dist", query: "TODO", path: "demo" },
        { type: "listFiles", command: "ls src dist", path: "demo" },
        { type: "search", command: "rg TODO src && rg FIXME dist", query: "TODO", path: "demo" },
      ]),
    ).toEqual([
      { type: "list", path: "demo" },
      { type: "search", query: "TODO", path: "demo" },
      { type: "list", path: "demo" },
      { type: "search", query: "TODO", path: "demo" },
      { type: "list", path: "demo" },
      { type: "search", query: "TODO", path: "demo" },
    ]);
  });

  it("keeps Codex metadata without an explicit target and preserves its search query", () => {
    expect(
      codexCommandActions([
        { type: "listFiles", command: "ls", path: " demo " },
        { type: "search", command: "rg TODO", query: " TODO ", path: " demo " },
        { type: "search", command: "rg TODO src/", query: "Codex query", path: "demo" },
      ]),
    ).toEqual([
      { type: "list", path: "demo" },
      { type: "search", query: "TODO", path: "demo" },
      { type: "search", query: "Codex query", path: "src/" },
    ]);
  });

  it("keeps commands plain when any action field cannot fit the wire", () => {
    expect(
      codexCommandActions([
        { type: "search", command: "rg", query: "x".repeat(1_025), path: "src" },
      ]),
    ).toEqual([]);
    expect(codexCommandActions([{ type: "read", command: "cat", name: "", path: "  " }])).toEqual(
      [],
    );
    expect(
      codexCommandActions([
        { type: "read", command: "cat", name: "file", path: "x".repeat(4_097) },
      ]),
    ).toEqual([]);
    expect(
      codexCommandActions([{ type: "listFiles", command: "ls", path: "x".repeat(4_097) }]),
    ).toEqual([]);
    expect(
      codexCommandActions([
        { type: "search", command: "rg", query: "foo", path: "x".repeat(4_097) },
      ]),
    ).toEqual([]);
    expect(codexCommandActions([{ type: "listFiles", command: "ls ''", path: "" }])).toEqual([]);
    expect(
      codexCommandActions(
        Array.from({ length: 17 }, () => ({ type: "listFiles", command: "ls", path: null })),
      ),
    ).toEqual([]);
  });

  it("keeps values at the wire limits and omits absent optional fields", () => {
    expect(
      codexCommandActions([
        { type: "search", command: "rg", query: "x".repeat(1_024), path: "p".repeat(4_096) },
        { type: "search", command: "rg -f patterns", query: null, path: null },
      ]),
    ).toEqual([
      { type: "search", query: "x".repeat(1_024), path: "p".repeat(4_096) },
      { type: "search" },
    ]);
  });
});
