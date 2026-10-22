import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import { parseNote } from "./frontmatter.ts";
import * as ProcessRunner from "../processRunner.ts";

export class NotesGit extends Context.Service<
  NotesGit,
  {
    readonly changed: Effect.Effect<void>;
    readonly flush: Effect.Effect<void>;
  }
>()("goat/notes/NotesGit") {}

const make = Effect.gen(function* () {
  const { notesDir } = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const signals = yield* Queue.sliding<void>(1);
  const lock = yield* Semaphore.make(1);
  let disabled = false;
  let initialized = false;
  const run = (args: ReadonlyArray<string>) =>
    runner.run({
      command: "git",
      cwd: notesDir,
      args: ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
      // ProcessRunner extends the inherited environment; undefined explicitly removes each override.
      env: {
        ...Object.fromEntries(
          Object.keys(process.env)
            .filter((key) => /^GIT_/iu.test(key))
            .map((key) => [key, undefined]),
        ),
        EMAIL: undefined,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "GOAT Notes",
        GIT_AUTHOR_EMAIL: "notes@goat.local",
        GIT_COMMITTER_NAME: "GOAT Notes",
        GIT_COMMITTER_EMAIL: "notes@goat.local",
      },
      timeout: "30 seconds",
      maxOutputBytes: 64 * 1024,
    });
  const flush = lock.withPermits(1)(
    Effect.gen(function* () {
      if (disabled) return;
      if (!initialized) {
        const init = yield* run(["init"]);
        if (init.code !== 0) return;
        initialized = true;
      }
      if ((yield* run(["add", "-A", "--", "."])).code !== 0) return;
      const diff = yield* run(["diff", "--cached", "--quiet"]);
      if (diff.code !== 1) return;
      const changed = yield* run(["diff", "--cached", "--name-only", "-z"]);
      if (changed.code !== 0) return;
      const names = changed.stdout.split("\0").filter(Boolean);
      let message = names.length > 1 ? `notes: ${names.length} changes` : "notes: update notes";
      if (names.length === 1) {
        const name = names[0]!;
        const staged = yield* run(["show", `:${name}`]);
        const author =
          staged.code === 0
            ? yield* Effect.try(() => parseNote(staged.stdout).updatedBy).pipe(
                Effect.orElseSucceed(() => null),
              )
            : null;
        message = `notes: ${staged.code === 0 ? "update" : "delete"} ${name.replace(/[\r\n]/gu, " ")}${author ? ` (${author})` : ""}`;
      }
      yield* run([
        "-c",
        "user.name=GOAT Notes",
        "-c",
        "user.email=notes@goat.local",
        "commit",
        "-m",
        message,
      ]);
    }).pipe(
      Effect.catch((error) => {
        if (error._tag === "ProcessSpawnError") disabled = true;
        return Effect.logWarning("Notes auto-commit unavailable", { reason: error._tag });
      }),
    ),
  );
  yield* Stream.fromQueue(signals).pipe(
    Stream.debounce("2 seconds"),
    Stream.runForEach(() => flush),
    Effect.forkScoped,
  );
  return NotesGit.of({ changed: Queue.offer(signals, undefined).pipe(Effect.asVoid), flush });
});
export const layer = Layer.effect(NotesGit, make);
