import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import packageJson from "../../package.json" with { type: "json" };
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";

it.layer(NodeServices.layer)("pruning runtimes on start", (it) => {
  const staleVersion = "0.0.1";
  const otherProcesses = ProcessRunner.ProcessRunner.of({
    run: () =>
      Effect.succeed({
        stdout: "p42\nftxt\nn/bin/sh\n",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  });

  const pruneOnStart = Effect.fn("test.prune_on_start")(function* (input: {
    readonly executable: "own runtime" | "elsewhere";
    readonly managed?: boolean;
    readonly symlinkedHome?: boolean;
    readonly unreadableUnit?: boolean;
    readonly servicePlistStarts?: string;
    readonly legacyUnit?: boolean;
    readonly servicePlistThroughLink?: boolean;
    readonly linuxLookupFailure?: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-prune-on-start-" });
    const realHome = path.join(tempDir, "home");
    const baseDir = input.symlinkedHome ? path.join(tempDir, "linked-home") : realHome;
    const versionsDir = path.join(baseDir, "runtime", "goat", "versions");
    yield* TestClock.setTime(24 * 60 * 60 * 1000);
    for (const version of [staleVersion, packageJson.version]) {
      const directory = path.join(realHome, "runtime", "goat", "versions", version);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "goat"), "");
      const sentinel = path.join(directory, ".install-complete");
      yield* fs.writeFileString(sentinel, `${version}\n`);
      yield* fs.utimes(sentinel, 0, 0);
    }
    if (input.symlinkedHome) yield* fs.symlink(realHome, baseDir);
    const userHome = path.join(tempDir, "user");
    if (input.servicePlistStarts !== undefined) {
      const agentsDir = path.join(userHome, "Library", "LaunchAgents");
      yield* fs.makeDirectory(agentsDir, { recursive: true });
      const programHome = input.servicePlistThroughLink
        ? path.join(tempDir, "alias-home")
        : baseDir;
      if (input.servicePlistThroughLink) yield* fs.symlink(realHome, programHome);
      const program = path.join(
        programHome,
        "runtime",
        "goat",
        "versions",
        input.servicePlistStarts,
        "goat",
      );
      yield* fs.writeFileString(
        path.join(
          agentsDir,
          input.legacyUnit ? "com.t3tools.t3code.service.plist" : "si.goat.service.plist",
        ),
        `<plist><dict>\n<key>ProgramArguments</key>\n<array>\n<string>${program}</string>\n<string>__service-launcher</string>\n</array>\n</dict></plist>\n`,
      );
    }
    if (input.linuxLookupFailure) {
      const unitDir = path.join(userHome, "manager-config", "systemd", "user");
      yield* fs.makeDirectory(unitDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(unitDir, "goat.service"),
        `[Service]\nExecStart=${path.join(versionsDir, staleVersion, "goat")} __service-launcher\n`,
      );
    }
    // Like `process.execPath`, the running runtime is reported by its real path.
    const executablePath =
      input.executable === "own runtime"
        ? yield* fs.realPath(path.join(versionsDir, packageJson.version, "goat"))
        : "/usr/local/bin/node";
    const removed = yield* ServerSelfUpdate.pruneRuntimesOnStart({
      baseDir,
      managed: input.managed ?? false,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFileString: (file, options) =>
          input.unreadableUnit && file.endsWith("si.goat.service.plist")
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readFile",
                  pathOrDescriptor: file,
                }),
              )
            : fs.readFileString(file, options),
      }),
      Effect.provideService(HostProcess.ExecutablePath, executablePath),
      Effect.provideService(HostProcess.Platform, input.linuxLookupFailure ? "linux" : "darwin"),
      Effect.provideService(
        HostProcess.Environment,
        input.linuxLookupFailure ? { XDG_CONFIG_HOME: path.join(userHome, "other-config") } : {},
      ),
      Effect.provideService(HostProcess.HomeDirectory, userHome),
      Effect.provideService(
        ProcessRunner.ProcessRunner,
        input.linuxLookupFailure
          ? ProcessRunner.ProcessRunner.of({
              run: (request) =>
                request.command === "busctl"
                  ? Effect.succeed({
                      stdout: "",
                      stderr: "unavailable",
                      code: ChildProcessSpawner.ExitCode(1),
                      timedOut: false,
                      stdoutTruncated: false,
                      stderrTruncated: false,
                      stdoutInvalidUtf8: false,
                      stderrInvalidUtf8: false,
                    })
                  : otherProcesses.run(request),
            })
          : otherProcesses,
      ),
    );
    return { removed, remaining: (yield* fs.readDirectory(versionsDir)).toSorted() };
  });

  // The SSH launcher runs `goat serve` straight from the pinned runtime, with no boot service.
  it.effect("prunes for a server started from its home's pinned runtime", () =>
    Effect.gen(function* () {
      const { removed, remaining } = yield* pruneOnStart({ executable: "own runtime" });
      expect(removed).toEqual([staleVersion]);
      expect(remaining).toEqual([packageJson.version]);
    }),
  );

  it.effect("recognizes its runtime through a symlinked GOAT home", () =>
    Effect.gen(function* () {
      const { removed } = yield* pruneOnStart({ executable: "own runtime", symlinkedHome: true });
      expect(removed).toEqual([staleVersion]);
    }),
  );

  it.effect("prunes for a boot-service server wherever it runs from", () =>
    Effect.gen(function* () {
      const { removed } = yield* pruneOnStart({ executable: "elsewhere", managed: true });
      expect(removed).toEqual([staleVersion]);
    }),
  );

  it.effect.each([
    { legacyUnit: false, servicePlistThroughLink: false },
    { legacyUnit: true, servicePlistThroughLink: true },
  ])(
    "keeps the runtime a stopped service starts, including legacy and symlinked homes",
    (options) =>
      Effect.gen(function* () {
        const { removed, remaining } = yield* pruneOnStart({
          executable: "own runtime",
          servicePlistStarts: staleVersion,
          ...options,
        });
        expect(removed).toEqual([]);
        expect(remaining).toEqual([staleVersion, packageJson.version].toSorted());
      }),
  );

  it.effect("keeps runtimes when the systemd manager path cannot be confirmed", () =>
    Effect.gen(function* () {
      const { removed, remaining } = yield* pruneOnStart({
        executable: "own runtime",
        linuxLookupFailure: true,
      });
      expect(removed).toEqual([]);
      expect(remaining).toEqual([staleVersion, packageJson.version].toSorted());
    }),
  );

  it.effect("does not prune when a service unit cannot be inspected", () =>
    Effect.gen(function* () {
      const { removed, remaining } = yield* pruneOnStart({
        executable: "own runtime",
        unreadableUnit: true,
      });
      expect(removed).toEqual([]);
      expect(remaining).toEqual([staleVersion, packageJson.version].toSorted());
    }),
  );

  it.effect("leaves runtimes alone for an unmanaged server started elsewhere", () =>
    Effect.gen(function* () {
      const { removed, remaining } = yield* pruneOnStart({ executable: "elsewhere" });
      expect(removed).toEqual([]);
      expect(remaining).toEqual([staleVersion, packageJson.version].toSorted());
    }),
  );
});
