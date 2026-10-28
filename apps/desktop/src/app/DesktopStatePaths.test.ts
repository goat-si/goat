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

  it("packaged builds keep state where the app-server probe searches, and dev builds never do", () => {
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
    const searched = (dir: string) =>
      desktopAppServerStateDirs.some((relative) => dir === `${home}/${relative}`);
    const packaged = [
      stateDir(base("1.2.3-nightly.20261027.1", false), false),
      stateDir(base("1.2.3-preview.20261027.1", false), false),
      stateDir(base("1.2.3-pr.1834.2", false), false),
      stateDir(base("1.2.3", false), false),
    ];
    for (const dir of packaged) assert.ok(searched(dir), dir);
    // A PR preview runs beside stable, so its migrations never touch stable's database.
    assert.equal(packaged[2], `${home}/.goat/desktop-nightly/userdata`);
    const development = [
      stateDir(base("1.2.3", true), true),
      stateDir(base("1.2.3", true, ["/home/user/.t3/dev"]), true), // goat-rename: legacy
    ];
    for (const dir of development) assert.ok(!searched(dir), dir);
  });
});
