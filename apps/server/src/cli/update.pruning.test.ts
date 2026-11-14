import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NetService from "@goat/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";
import { makeHarness } from "../cloud/bootService.testkit.ts";
import * as ProcessRunner from "../processRunner.ts";
import { updateCommand } from "./update.ts";

it.layer(NodeServices.layer)("goat update runtime pruning", (it) => {
  it.effect.each([
    { scenario: "unconfirmed manager", lookupFails: true, unit: "goat.service", keep: true },
    {
      scenario: "systemd absent in a container sharing a host service home",
      lookupFails: false,
      unit: "goat.service",
      keep: true,
    },
    { scenario: "current service", lookupFails: false, unit: "goat.service", keep: true },
    { scenario: "legacy service", lookupFails: false, unit: "t3code.service", keep: true },
    {
      scenario: "unreadable current unit",
      lookupFails: false,
      unit: "unreadable-current",
      keep: true,
    },
    { scenario: "unreadable legacy unit", lookupFails: false, unit: "unreadable", keep: true },
    { scenario: "no unit reference", lookupFails: false, unit: "none", keep: false },
  ])("preserves only safe candidates for $scenario", ({ scenario, lookupFails, unit, keep }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* fs.makeTempDirectoryScoped({ prefix: "goat-update-config-" });
      const shellConfig = path.join(config, "shell");
      const managerConfig = path.join(config, "manager");
      const h = yield* makeHarness("linux", undefined, shellConfig, managerConfig);
      const stale = "0.0.1";
      const target = "999.0.0";
      yield* h.makeService(undefined, stale);
      yield* h.makeService(undefined, target);
      const versions = path.join(h.baseDir, "runtime", "goat", "versions");
      const staleDir = path.join(versions, stale);
      const unitDir = path.join(managerConfig, "systemd", "user");
      yield* fs.makeDirectory(unitDir, { recursive: true });
      if (unit === "goat.service" || unit === "t3code.service") {
        yield* fs.writeFileString(
          path.join(unitDir, unit),
          `[Service]\nExecStart=${path.join(staleDir, "goat")} __service-launcher\n`,
        );
      }
      yield* fs.utimes(path.join(staleDir, ".install-complete"), 0, 0);
      yield* TestClock.setTime(24 * 60 * 60 * 1000);
      if (lookupFails)
        h.control.failCommand =
          "busctl --user --json=short get-property org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager UnitPath";
      const runnerLayer = vi
        .spyOn(ProcessRunner, "layer", "get")
        .mockReturnValue(Layer.succeed(ProcessRunner.ProcessRunner, h.runner));
      try {
        yield* Command.runWith(updateCommand, { version: "0.1.0" })([
          target,
          "--base-dir",
          h.baseDir,
          "--allow-downgrade",
        ]).pipe(
          Effect.provide(NetService.layer),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: (file) =>
              file === "/run/systemd/system" && scenario.startsWith("systemd absent")
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "NotFound",
                      module: "FileSystem",
                      method: "stat",
                      pathOrDescriptor: file,
                    }),
                  )
                : fs.stat(file === "/run/systemd/system" ? config : file),
            readDirectory: (file, options) =>
              file === "/proc" ? Effect.succeed(["42"]) : fs.readDirectory(file, options),
            readLink: (file) =>
              file === "/proc/42/exe" ? Effect.succeed("/usr/bin/unrelated") : fs.readLink(file),
            readFileString: (file, options) =>
              (unit === "unreadable" && file === path.join(unitDir, "t3code.service")) ||
              (unit === "unreadable-current" && file === path.join(unitDir, "goat.service"))
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
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.ExecutablePath, "/usr/bin/goat"),
          Effect.provideService(HostProcess.HomeDirectory, h.home),
          Effect.provideService(HostProcess.UserId, 501),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { HOME: h.home, PATH: "/usr/bin", XDG_CONFIG_HOME: shellConfig },
              }),
            ),
          ),
        );
        expect(yield* fs.exists(staleDir)).toBe(keep);
      } finally {
        runnerLayer.mockRestore();
      }
    }),
  );
});
