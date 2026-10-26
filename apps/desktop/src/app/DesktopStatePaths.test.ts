import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { resolveDesktopBaseDir } from "./DesktopStatePaths.ts";

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

describe("resolveDesktopBaseDir", () => {
  it("keeps a hand-launched dev build on dev state left in the legacy home", () => {
    assert.equal(devBaseDir([]), "/home/user/.goat");
    assert.equal(devBaseDir(["/home/user/.t3/dev"]), "/home/user/.t3"); // goat-rename: legacy
    assert.equal(devBaseDir(["/home/user/.t3/dev", "/home/user/.goat/dev"]), "/home/user/.goat"); // goat-rename: legacy
  });
});
