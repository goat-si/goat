// @effect-diagnostics nodeBuiltinImport:off -- Proves a child process receives the view's variables.
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "vite-plus/test";

import { overlayEnvironment } from "./environmentOverlay.ts";

describe("environment overlay", () => {
  it("reads the base's current values, with its own variables on top", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/old/bin", KEEP: "base", SHADOWED: "base" };
    const view = overlayEnvironment(base, { SHADOWED: "own", ADDED: "own" });
    expect({ ...view }).toEqual({
      PATH: "/old/bin",
      KEEP: "base",
      SHADOWED: "own",
      ADDED: "own",
    });

    base.PATH = "/recovered/bin";
    base.LATER = "base";
    delete base.KEEP;
    expect(view.PATH).toBe("/recovered/bin");
    expect(Object.keys(view)).toEqual(["PATH", "SHADOWED", "LATER", "ADDED"]);
    expect(Object.entries(view)).toContainEqual(["LATER", "base"]);
    expect("KEEP" in view).toBe(false);
    expect(JSON.parse(JSON.stringify(view))).toEqual({ ...view });
  });

  it("hides a base variable, and keeps writes and deletes out of the base", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/bin", SECRET: "base", OTHER: "base" };
    const view = overlayEnvironment(base, { SECRET: undefined });
    expect(view.SECRET).toBeUndefined();
    expect(Object.keys(view)).toEqual(["PATH", "OTHER"]);

    view.OTHER = "own";
    view.NEW = "own";
    delete view.PATH;
    expect({ ...view }).toEqual({ OTHER: "own", NEW: "own" });
    expect(base).toEqual({ PATH: "/bin", SECRET: "base", OTHER: "base" });

    base.SECRET = "changed";
    expect(view.SECRET).toBeUndefined();
  });

  it("stacks, so a view of a view still follows the first base", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/old/bin" };
    const view = overlayEnvironment(overlayEnvironment(base, { A: "1" }), { B: "2" });
    base.PATH = "/recovered/bin";
    expect({ ...view }).toEqual({ PATH: "/recovered/bin", A: "1", B: "2" });
  });

  it("hands a child process the current variables", () => {
    const base: NodeJS.ProcessEnv = { GOAT_BASE: "old", GOAT_HIDDEN: "base" };
    const view = overlayEnvironment(base, { GOAT_OWN: "own", GOAT_HIDDEN: undefined });
    base.GOAT_BASE = "current";
    const script =
      "process.stdout.write([process.env.GOAT_BASE, process.env.GOAT_OWN, process.env.GOAT_HIDDEN].join())";
    expect(
      NodeChildProcess.execFileSync(process.execPath, ["-e", script], {
        env: view,
        encoding: "utf8",
      }),
    ).toBe("current,own,");
  });
});
