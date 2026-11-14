import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import { bootServiceUnitPaths } from "./bootServiceUnitPaths.ts";

it.layer(NodeServices.layer)("systemd service unit lookup", (it) => {
  it.effect.each([
    { name: "a missing runtime directory", uid: 501, env: {}, expected: "/run/user/501" },
    {
      name: "an inherited runtime directory",
      uid: 501,
      env: { XDG_RUNTIME_DIR: "/existing" },
      expected: undefined,
    },
    { name: "root under sudo", uid: 0, env: { SUDO_USER: "sam" }, expected: undefined },
  ])("uses the installer's environment for $name", ({ uid, env, expected }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temp = yield* fs.makeTempDirectoryScoped();
      let passedRuntime: string | undefined;
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) => {
          passedRuntime = input.env?.XDG_RUNTIME_DIR;
          return Effect.succeed({
            stdout: JSON.stringify({
              data: ["/manager/systemd/user.control", "/manager/systemd/user"],
            }),
            stderr: "",
            code: ChildProcessSpawner.ExitCode(expected === passedRuntime ? 0 : 1),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          });
        },
      });
      const result = yield* bootServiceUnitPaths().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stat: (file) => fs.stat(file === "/run/systemd/system" ? temp : file),
        }),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.UserId, uid),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      );
      expect(passedRuntime).toBe(expected);
      expect(result).toEqual([
        "/manager/systemd/user/goat.service",
        "/manager/systemd/user/t3code.service",
      ]);
    }),
  );
});
