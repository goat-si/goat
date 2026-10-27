import { assert, describe, it } from "@effect/vitest";
import { desktopAppServerStateDirs } from "@goat/shared/desktopAppServer";
import * as Option from "effect/Option";

import { resolveDesktopBaseDir, resolveDesktopStateDir } from "./DesktopStatePaths.ts";

const joinPath = (...segments: string[]) => segments.join("/");
const devBaseDir = (existing: ReadonlyArray<string>) =>
  resolveDesktopBaseDir({
    homeDirectory: "/home/user",
    joinPath,
    goatHome: Option.none(),
    isDevelopment: true,
    appVersion: "1.2.3",
    pathExists: (path) => existing.includes(path),
  });

const stateDir = (baseDir: string, isDevelopment: boolean) =>
  resolveDesktopStateDir({
    baseDir,
    isDevelopment,
    joinPath,
    goatHome: Option.none(),
  });

describe("resolveDesktopBaseDir", () => {
  it("keeps a hand-launched dev build on dev state left in the legacy home", () => {
    assert.equal(devBaseDir([]), "/home/user/.goat");
    assert.equal(devBaseDir(["/home/user/.t3/dev"]), "/home/user/.t3"); // goat-rename: legacy
    assert.equal(devBaseDir(["/home/user/.t3/dev", "/home/user/.goat/dev"]), "/home/user/.goat"); // goat-rename: legacy
  });

  it("every default desktop state directory is one the app-server probe searches", () => {
    const home = "/home/user";
    const base = (
      appVersion: string,
      isDevelopment: boolean,
      existing: ReadonlyArray<string> = [],
    ) =>
      resolveDesktopBaseDir({
        homeDirectory: home,
        joinPath,
        goatHome: Option.none(),
        isDevelopment,
        appVersion,
        pathExists: (path) => existing.includes(path),
      });
    const dirs = [
      stateDir(base("1.2.3-nightly.20261027.1", false), false),
      stateDir(base("1.2.3-preview.20261027.1", false), false),
      stateDir(base("1.2.3", false), false),
      stateDir(base("1.2.3", true), true),
      stateDir(base("1.2.3", true, ["/home/user/.t3/dev"]), true),
    ];
    for (const dir of dirs) {
      assert.ok(
        desktopAppServerStateDirs.some((relative) => dir === `${home}/${relative}`),
        dir,
      );
    }
  });
});
