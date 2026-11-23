import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const SERVICE_KEYS = [
  "HKLM\\SYSTEM\\CurrentControlSet\\Services\\WSLService",
  "HKLM\\SYSTEM\\CurrentControlSet\\Services\\LxssManager",
] as const;

const serviceRegistered = Effect.scoped(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const registered = yield* Effect.forEach(
      SERVICE_KEYS,
      (key) =>
        spawner
          .spawn(
            ChildProcess.make("reg.exe", ["query", key], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              killSignal: "SIGTERM",
              forceKillAfter: Duration.seconds(1),
            }),
          )
          .pipe(Effect.flatMap((handle) => handle.exitCode)),
      { concurrency: "unbounded" },
    );
    return registered.some((code) => code === 0);
  }),
).pipe(
  Effect.timeoutOption(Duration.seconds(5)),
  Effect.map(Option.getOrElse(() => false)),
  Effect.orElseSucceed(() => false),
);

export const makeIsAvailable = Effect.fn("DesktopWslEnvironment.makeIsAvailable")(function* (
  platform: NodeJS.Platform,
  windir: string,
) {
  if (platform !== "win32") return false;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  if (
    !(yield* fs
      .exists(path.join(windir, "System32", "wsl.exe"))
      .pipe(Effect.orElseSucceed(() => false)))
  )
    return false;
  return yield* serviceRegistered;
});
