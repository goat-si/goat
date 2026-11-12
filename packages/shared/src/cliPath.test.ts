import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";

import { appendWellKnownCliDirs, wellKnownCliDirs, withLoginShellPathNote } from "./cliPath.ts";
import * as HostProcess from "./HostProcess.ts";
import { resolveCommandPath } from "./shell.ts";

describe("well-known CLI folders", () => {
  it("adds the folders last without reordering or repeating what PATH already has", () => {
    expect(
      appendWellKnownCliDirs("/shell/bin:/Users/me/.local/bin/:/usr/bin", "darwin", "/Users/me/"),
    ).toBe(
      "/shell/bin:/Users/me/.local/bin/:/usr/bin:/Users/me/.bun/bin:/opt/homebrew/bin:/usr/local/bin",
    );
    expect(appendWellKnownCliDirs("/usr/bin", "linux", "/home/me")).toBe(
      "/usr/bin:/home/me/.local/bin:/home/me/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin",
    );
  });

  it("names absolute folders only and leaves Windows and a missing PATH alone", () => {
    for (const home of [undefined, "", "relative/home", "~", "/"]) {
      expect(wellKnownCliDirs("linux", home)).toEqual([
        "/home/linuxbrew/.linuxbrew/bin",
        "/usr/local/bin",
      ]);
    }
    expect(wellKnownCliDirs("win32", "C:\\Users\\me")).toEqual([]);
    expect(appendWellKnownCliDirs("C:\\Windows", "win32", "C:\\Users\\me")).toBe("C:\\Windows");
    expect(appendWellKnownCliDirs(undefined, "darwin", "/Users/me")).toBeUndefined();
    expect(appendWellKnownCliDirs(null, "darwin", "/Users/me")).toBeNull();
    expect(appendWellKnownCliDirs("", "darwin", "/Users/me")).toBe("");
  });

  it.effect("finds a CLI installed into ~/.local/bin after PATH was built", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-cli-path-" });
      const env = { PATH: appendWellKnownCliDirs("/usr/bin", "linux", home) };
      const bin = path.join(home, ".local", "bin");
      expect(yield* fs.exists(bin)).toBe(false);
      yield* fs.makeDirectory(bin, { recursive: true });
      yield* fs.writeFileString(path.join(bin, "goat-fresh-cli"), "#!/bin/sh\n", { mode: 0o755 });
      expect(yield* resolveCommandPath("goat-fresh-cli", { env })).toBe(
        path.join(bin, "goat-fresh-cli"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("login shell PATH note", () => {
  it("explains a missing CLI only while the login shell PATH is unread", () => {
    const message = "Claude Agent CLI (`claude`) was not found on PATH.";
    expect(withLoginShellPathNote(message, {})).toBe(message);
    const noted = withLoginShellPathNote(message, { GOAT_DESKTOP_SHELL_DISCOVERY_PENDING: "1" });
    expect(noted.startsWith(message + " GOAT has not been able to read the PATH")).toBe(true);
    expect(noted).toContain("Binary path");
  });
});
