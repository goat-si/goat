import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const WSL_PATH_OUTPUT_LIMIT = 32768;

export const resolveWslFileManagerPath = Effect.fn("externalLauncher.resolveWslFileManagerPath")(
  function* (target: string, distroName: string) {
    const relative = target.replace(/^\/+/, "").replaceAll("/", "\\");
    const fallback = `\\\\wsl.localhost\\${distroName}${relative.length > 0 ? `\\${relative}` : ""}`;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner
      .spawn(
        ChildProcess.make("wslpath", ["-w", target], {
          stdin: "ignore",
          stderr: "ignore",
          forceKillAfter: "1 second",
        }),
      )
      .pipe(
        Effect.flatMap((handle) =>
          Effect.all(
            [
              handle.stdout.pipe(
                Stream.decodeText(),
                Stream.runFold(
                  () => "",
                  (text, chunk) =>
                    text.length + chunk.length <= WSL_PATH_OUTPUT_LIMIT
                      ? text + chunk
                      : "\0".repeat(WSL_PATH_OUTPUT_LIMIT),
                ),
              ),
              handle.exitCode,
            ],
            { concurrency: 2 },
          ),
        ),
        Effect.map(([stdout, status]) => {
          const result = stdout.trim();
          return status === 0 && result.length > 0 && !result.includes("\0") ? result : fallback;
        }),
        Effect.scoped,
        Effect.timeout("2 seconds"),
        Effect.orElseSucceed(() => fallback),
      );
  },
);
