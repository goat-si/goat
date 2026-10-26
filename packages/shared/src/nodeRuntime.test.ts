import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import * as HostProcess from "./HostProcess.ts";
import {
  resolveNodeExecutable,
  resolveSelfInvocation,
  resolveSelfInvocationCommand,
  selfInvocationArgs,
} from "./nodeRuntime.ts";
import { symlinksSupported } from "./testing/symlinks.ts";

describe("Self invocation", () => {
  it.effect(
    "readiness and the lease proxy choose the same executable, so a check proves the agents' parent",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const executable = path.join(directory, "GOAT.app", "Contents", "MacOS", "GOAT");
        const helper = path.join(
          directory,
          "GOAT.app",
          "Contents",
          "Frameworks",
          "GOAT Helper.app",
          "Contents",
          "MacOS",
          "GOAT Helper",
        );
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.makeDirectory(path.dirname(helper), { recursive: true });
        yield* fs.writeFileString(
          path.join(path.dirname(path.dirname(helper)), "Info.plist"),
          "<plist><dict><key>LSUIElement</key><true/></dict></plist>",
        );
        for (const platform of ["darwin", "win32", "linux"] as const) {
          const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(
              Effect.provideService(HostProcess.ExecutablePath, executable),
              Effect.provideService(HostProcess.IsExecutable, false),
              Effect.provideService(HostProcess.Platform, platform),
              Effect.provideService(HostProcess.Arguments, [executable, "dist/bin.mjs"]),
            );
          const proxy = yield* provide(resolveSelfInvocation());
          const readiness = yield* provide(resolveSelfInvocationCommand());
          expect(readiness).toBe(proxy.command);
          // Only macOS swaps in the background helper; the Windows helper accepts only GOAT.exe.
          expect(readiness).toBe(platform === "darwin" ? helper : executable);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("runs the entrypoint script with the current runtime", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const invocation = yield* resolveSelfInvocation().pipe(
        Effect.provideService(HostProcess.ExecutablePath, "/runtime/node"),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provideService(HostProcess.Arguments, ["/runtime/node", "dist/bin.mjs", "serve"]),
      );
      expect(invocation.command).toBe("/runtime/node");
      expect(invocation.entrypoint).toBe(path.resolve("dist/bin.mjs"));
      expect(selfInvocationArgs(invocation, ["acp-mcp-bridge"])).toEqual([
        path.resolve("dist/bin.mjs"),
        "acp-mcp-bridge",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the bundled background helper for macOS Electron children", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      for (const [name, executableName, helperName] of [
        ["GOAT (Nightly)", "GOAT (Nightly)", "GOAT (Nightly) Helper"],
        ["GOAT (Dev)", "Electron", "Electron Helper"],
      ] as const) {
        const executable = path.join(directory, `${name}.app`, "Contents", "MacOS", executableName);
        const helper = path.join(
          directory,
          `${name}.app`,
          "Contents",
          "Frameworks",
          `${helperName}.app`,
          "Contents",
          "MacOS",
          helperName,
        );
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.makeDirectory(path.dirname(helper), { recursive: true });
        yield* fs.writeFileString(executable, "app", { flag: "wx" });
        yield* fs.writeFileString(helper, "helper", { flag: "wx" });
        yield* fs.writeFileString(
          path.join(path.dirname(path.dirname(helper)), "Info.plist"),
          "<plist><dict><key>NSHighResolutionCapable</key><true/><key>LSUIElement</key>\n<true/></dict></plist>",
          { flag: "wx" },
        );
        const invocation = yield* resolveSelfInvocation().pipe(
          Effect.provideService(HostProcess.ExecutablePath, executable),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(HostProcess.Arguments, [executable, "dist/bin.mjs", "serve"]),
        );
        expect(invocation.command).toBe(helper);
        expect(invocation.entrypoint).toBe(path.resolve("dist/bin.mjs"));
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the current executable without a background Electron helper", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const executable = path.join(directory, "App.app", "Contents", "MacOS", "node");
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.writeFileString(executable, "node", { flag: "wx" });
      for (const plist of [
        undefined,
        "<plist><dict><key>LSUIElement</key><false/><key>NSHighResolutionCapable</key><true/></dict></plist>",
      ]) {
        if (plist !== undefined) {
          const contents = path.join(
            directory,
            "App.app",
            "Contents",
            "Frameworks",
            "node Helper.app",
            "Contents",
          );
          yield* fs.makeDirectory(path.join(contents, "MacOS"), { recursive: true });
          yield* fs.writeFileString(path.join(contents, "Info.plist"), plist, { flag: "wx" });
          yield* fs.writeFileString(path.join(contents, "MacOS", "node Helper"), "helper", {
            flag: "wx",
          });
        }
        const invocation = yield* resolveSelfInvocation().pipe(
          Effect.provideService(HostProcess.ExecutablePath, executable),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(HostProcess.Arguments, [executable, "dist/bin.mjs", "serve"]),
        );
        expect(invocation.command).toBe(executable);
        expect(invocation.entrypoint).toBe(path.resolve("dist/bin.mjs"));
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("passes subcommands straight to the standalone executable", () =>
    Effect.gen(function* () {
      // Node repeats the binary at argv[1] for a single-executable; it is not a script.
      const invocation = yield* resolveSelfInvocation().pipe(
        Effect.provideService(HostProcess.ExecutablePath, "/packaged/t3"),
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provideService(HostProcess.Arguments, ["/packaged/t3", "/packaged/t3", "serve"]),
      );
      expect(invocation).toEqual({ command: "/packaged/t3", entrypoint: undefined });
      expect(selfInvocationArgs(invocation, ["acp-mcp-bridge"])).toEqual(["acp-mcp-bridge"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Node runtime selection", () => {
  it.effect("keeps the current Node or Electron runtime without requiring Node on PATH", () =>
    Effect.gen(function* () {
      for (const executable of ["/runtime/node", "/Applications/T3 Code.app/Electron"]) {
        expect(
          yield* resolveNodeExecutable("Local device support", { PATH: "" }).pipe(
            Effect.provideService(HostProcess.ExecutablePath, executable),
            Effect.provideService(HostProcess.IsExecutable, false),
          ),
        ).toBe(executable);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses installed Node instead of the standalone GOAT executable", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(
        yield* resolveNodeExecutable("Local device support", {
          PATH: path.dirname(process.execPath),
        }),
      ).toBe(process.execPath);
    }).pipe(
      Effect.provideService(HostProcess.ExecutablePath, "/packaged/t3"),
      Effect.provideService(HostProcess.IsExecutable, true),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("finds a newly installed runtime immediately after a failed lookup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const platform = yield* HostProcess.Platform;
      const node = path.join(directory, platform === "win32" ? "node.exe" : "node");
      const env = { PATH: directory };
      expect(
        Result.isFailure(
          yield* resolveNodeExecutable("Local device support", env).pipe(Effect.result),
        ),
      ).toBe(true);
      yield* fs.copyFile(process.execPath, node);
      yield* fs.chmod(node, 0o755);
      expect(yield* resolveNodeExecutable("Local device support", env)).toBe(node);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.ExecutablePath, "/packaged/t3"),
      Effect.provideService(HostProcess.IsExecutable, true),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("uses node.exe even when Windows batch wrappers appear first on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const wrappers = path.join(directory, "wrappers");
      const runtime = path.join(directory, "runtime");
      yield* fs.makeDirectory(wrappers);
      yield* fs.makeDirectory(runtime);
      yield* fs.writeFileString(path.join(wrappers, "node.cmd"), "@echo off");
      yield* fs.writeFileString(path.join(wrappers, "node.bat"), "@echo off");
      const node = path.join(runtime, "node.exe");
      yield* fs.copyFile(process.execPath, node);
      expect(
        yield* resolveNodeExecutable("Local device support", {
          PATH: `${wrappers};${runtime}`,
          PATHEXT: ".CMD;.BAT",
        }),
      ).toBe(node);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.ExecutablePath, "/packaged/t3"),
      Effect.provideService(HostProcess.IsExecutable, true),
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("reports install guidance when Windows only has batch runtime wrappers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(directory, "node.cmd"), "@echo off");
      yield* fs.writeFileString(path.join(directory, "node.bat"), "@echo off");
      const error = yield* resolveNodeExecutable("Local device support", {
        PATH: directory,
        PATHEXT: ".CMD;.BAT;.EXE",
      }).pipe(Effect.flip);
      expect(error._tag).toBe("NodeRuntimeUnavailableError");
      expect(error.message).toContain("Install Node.js");
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.IsExecutable, true),
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("rejects a hard-linked node alias pointing back at the standalone app", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const platform = yield* HostProcess.Platform;
      const executable = path.join(directory, platform === "win32" ? "t3.exe" : "t3");
      const node = path.join(directory, platform === "win32" ? "node.exe" : "node");
      yield* fs.writeFileString(executable, "standalone executable fixture");
      yield* fs.chmod(executable, 0o755);
      yield* fs.link(executable, node);
      const error = yield* resolveNodeExecutable("Local device support", { PATH: directory }).pipe(
        Effect.provideService(HostProcess.ExecutablePath, executable),
        Effect.flip,
      );
      expect(error._tag).toBe("NodeRuntimeUnavailableError");
      expect(error.message).toContain("Install Node.js");
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.IsExecutable, true),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect.skipIf(!symlinksSupported)("preserves the node alias used by runtime launchers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const platform = yield* HostProcess.Platform;
      const node = path.join(directory, platform === "win32" ? "node.exe" : "node");
      yield* fs.symlink(process.execPath, node);
      expect(yield* resolveNodeExecutable("Local device support", { PATH: directory })).toBe(node);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.ExecutablePath, "/packaged/t3"),
      Effect.provideService(HostProcess.IsExecutable, true),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects a node alias pointing back at the standalone app",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const platform = yield* HostProcess.Platform;
        const node = path.join(directory, platform === "win32" ? "node.exe" : "node");
        yield* fs.symlink(process.execPath, node);
        const error = yield* resolveNodeExecutable("Local device support", {
          PATH: directory,
        }).pipe(Effect.flip);
        expect(error.message).toContain("Install Node.js");
      }).pipe(
        Effect.scoped,
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provide(NodeServices.layer),
      ),
  );
});
