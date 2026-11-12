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
    // A home holding the PATH delimiter would split into a relative entry such as ./.local/bin.
    for (const home of [undefined, "", "relative/home", "~", "/", "//", "/Users/alice:."]) {
      expect(wellKnownCliDirs("linux", home)).toEqual([
        "/home/linuxbrew/.linuxbrew/bin",
        "/usr/local/bin",
      ]);
    }
    expect(appendWellKnownCliDirs("/usr/bin", "darwin", "/Users/alice:.")).toBe(
      "/usr/bin:/opt/homebrew/bin:/usr/local/bin",
    );
    expect(wellKnownCliDirs("win32", "C:\\Users\\me")).toEqual([]);
    expect(appendWellKnownCliDirs("C:\\Windows", "win32", "C:\\Users\\me")).toBe("C:\\Windows");
    expect(appendWellKnownCliDirs(undefined, "darwin", "/Users/me")).toBeUndefined();
    expect(appendWellKnownCliDirs(null, "darwin", "/Users/me")).toBeNull();
    expect(appendWellKnownCliDirs("", "darwin", "/Users/me")).toBe("");
  });

  it("keeps a home folder whose name ends in a space, and only strips trailing slashes", () => {
    expect(wellKnownCliDirs("darwin", "/Users/al //")).toEqual([
      "/Users/al /.local/bin",
      "/Users/al /.bun/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
    expect(appendWellKnownCliDirs("/usr/bin:/Users/al/.local/bin", "darwin", "/Users/al ")).toBe(
      "/usr/bin:/Users/al/.local/bin:/Users/al /.local/bin:/Users/al /.bun/bin:/opt/homebrew/bin:/usr/local/bin",
    );
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
  it("explains a missing CLI only on macOS and Linux while the login shell PATH is unread", () => {
    const message = "Claude Agent CLI (`claude`) was not found on PATH.";
    const pending = { GOAT_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
    expect(withLoginShellPathNote(message, { env: {}, platform: "darwin" })).toBe(message);
    for (const platform of ["darwin", "linux"] as const) {
      const noted = withLoginShellPathNote(message, { env: pending, platform });
      // Conditional: the server may be on a cached PATH, or hold a copy made before the shell answered.
      expect(
        noted.startsWith(
          message +
            " GOAT may not have your login shell's current PATH yet, so it may have searched only",
        ),
      ).toBe(true);
      expect(noted).toContain("Binary path");
    }
    // Windows desktop sets the same variable, but has no login shell to wait for.
    expect(withLoginShellPathNote(message, { env: pending, platform: "win32" })).toBe(message);
  });
});
