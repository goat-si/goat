import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const SESSION_OUTPUT_LIMIT = 65536;

export const readGraphicalSessionOutput = Effect.fn("externalLauncher.readGraphicalSessionOutput")(
  function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        "busctl",
        [
          "--user",
          "--json=short",
          "get-property",
          "org.freedesktop.systemd1",
          "/org/freedesktop/systemd1",
          "org.freedesktop.systemd1.Manager",
          "Environment",
        ],
        { stdin: "ignore", stderr: "ignore", forceKillAfter: "1 second" },
      ),
    );
    const [output, status] = yield* Effect.all(
      [
        handle.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (text, chunk) =>
              text.length + chunk.length <= SESSION_OUTPUT_LIMIT
                ? text + chunk
                : "\0".repeat(SESSION_OUTPUT_LIMIT),
          ),
        ),
        handle.exitCode,
      ],
      { concurrency: 2 },
    );
    return status === 0 && !output.includes("\0") ? output : "";
  },
  Effect.scoped,
);
