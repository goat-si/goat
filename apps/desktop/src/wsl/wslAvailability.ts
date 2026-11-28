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
// Always present; when reg.exe cannot read it (e.g. "Prevent access to registry editing tools"),
// a failed service query says nothing about WSL, so fall back to trusting wsl.exe.
const SERVICES_ROOT_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Services";

const serviceRegistered = Effect.scoped(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const [rootReadable, ...servicesFound] = yield* Effect.forEach(
      [SERVICES_ROOT_KEY, ...SERVICE_KEYS],
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
          .pipe(
            Effect.flatMap((handle) => handle.exitCode),
            Effect.map((code) => (code as unknown as number) === 0),
          ),
      { concurrency: "unbounded" },
    );
    return rootReadable === false || servicesFound.includes(true);
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
