import { expect, it } from "@effect/vitest";
import * as ByteSize from "effect/ByteSize";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { sessionReadArgs } from "./sessionRead.ts";
import {
  cloudAssistant,
  cloudPrompt,
  defaultReply,
  LOGIN,
  makeCliHarness,
  TELEPORT_RESULT,
  teleportTranscript,
} from "./testing.ts";

const ROOT = "/fixture/goat/reads";
const PROJECTS = "/fixture/claude/projects";
const SCRATCH = ROOT + "/read-AbC123";
const OWNED = PROJECTS + "/-fixture-goat-reads-read-AbC123";
// Another project whose name happens to contain the same generated token.
const UNRELATED = PROJECTS + "/-Users-dev-read-AbC123-notes";
const FORK = "b29613b5-0000-4000-8000-000000000001";
const TRANSCRIPT = teleportTranscript([
  cloudPrompt("task", "2026-10-23T10:00:01.000Z"),
  cloudAssistant({ type: "text", text: "Answer." }, "end_turn"),
]);
const info: FileSystem.File.Info = {
  type: "File",
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0n,
  ino: Option.none(),
  mode: 0o600,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: ByteSize.bytes(TRANSCRIPT.length),
  blksize: Option.none(),
  blocks: Option.none(),
};

const makeRead = (
  options: {
    readonly teleport?: string;
    /** Git's answers in order: outside, inside, or a fatal config error that also exits 128. */
    readonly git?: ReadonlyArray<"outside" | "inside" | "broken">;
    readonly stuck?: (path: string, attempt: number) => boolean;
    /** Holds the transcript read open until the test lets it go. */
    readonly reading?: Deferred.Deferred<void>;
    /** Holds cleanup's first removal for one test-clock second after reporting it started. */
    readonly removing?: Deferred.Deferred<void>;
  } = {},
) =>
  Effect.gen(function* () {
    // A small file tree: Claude's teleport writes the owned project directory and transcript.
    const present = new Set([PROJECTS, UNRELATED]);
    const attempts = new Map<string, number>();
    const git = [...(options.git ?? ["outside"])];
    const h = yield* makeCliHarness(
      (args) => {
        if (args[0] === "rev-parse") {
          const answer = git.shift() ?? "outside";
          return answer === "inside"
            ? { code: 0, stdout: "true\n" }
            : {
                code: 128,
                stdout: "",
                stderr:
                  answer === "outside"
                    ? "fatal: not a git repository (or any of the parent directories): .git\n"
                    : "fatal: bad boolean config value 'invalid' for 'core.bare'\n",
              };
        }
        if (args[0] === "auth")
          return {
            code: 0,
            stdout: JSON.stringify({
              loggedIn: true,
              authMethod: "claude.ai",
              projectsDirectory: PROJECTS,
            }),
          };
        if (args[0] === "--print") {
          present.add(OWNED).add(OWNED + "/" + FORK + ".jsonl");
          return { code: 0, stdout: options.teleport ?? TELEPORT_RESULT };
        }
        if (args[0] === "--help")
          return { code: 0, stdout: "Commands:\n  purge [options] [path]\n" };
        if (args[0] === "purge") return { code: 0, stdout: "Purged 1 item(s)\n" };
        return defaultReply(args);
      },
      false,
      {
        fileSystem: {
          makeDirectory: () => Effect.void,
          makeTempDirectory: (input) =>
            Effect.sync(() => {
              const folder = (input?.directory ?? "/tmp") + "/" + (input?.prefix ?? "") + "AbC123";
              present.add(folder);
              return folder;
            }),
          realPath: (folder) => Effect.succeed(folder),
          readDirectory: (folder) =>
            Effect.succeed(
              [...present].flatMap((entry) =>
                entry.startsWith(folder + "/") && !entry.slice(folder.length + 1).includes("/")
                  ? [entry.slice(folder.length + 1)]
                  : [],
              ),
            ),
          exists: (target) => Effect.succeed(present.has(target)),
          stat: () => Effect.succeed(info),
          readFileString: () =>
            options.reading
              ? Deferred.succeed(options.reading, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.as(TRANSCRIPT),
                )
              : Effect.succeed(TRANSCRIPT),
          remove: (target) =>
            Effect.suspend(() =>
              options.removing && attempts.size === 0
                ? Deferred.succeed(options.removing, undefined).pipe(
                    Effect.andThen(Effect.sleep("1 second")),
                  )
                : Effect.void,
            ).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  const attempt = (attempts.get(target) ?? 0) + 1;
                  attempts.set(target, attempt);
                  if (options.stuck?.(target, attempt))
                    return Effect.fail(
                      PlatformError.systemError({
                        _tag: "Busy",
                        module: "FileSystem",
                        method: "remove",
                      }),
                    );
                  for (const entry of present)
                    if (entry === target || entry.startsWith(target + "/")) present.delete(entry);
                  return Effect.void;
                }),
              ),
            ),
        },
      },
    );
    const commands = () =>
      h.commands.map((command) => ({ args: command.args, cwd: command.options.cwd }));
    return { service: h.service, present, commands };
  });

it.effect(
  "a read teleports into its own folder, returns the cloud transcript and leaves no local copy",
  () =>
    Effect.gen(function* () {
      const h = yield* makeRead();
      const read = yield* h.service.readSession(LOGIN, ROOT, "session_ABC123");
      expect(read).toEqual({ transcript: TRANSCRIPT, costUsd: 0.0064 });
      expect(h.commands()).toContainEqual({
        args: sessionReadArgs("session_ABC123"),
        cwd: SCRATCH,
      });
      expect(sessionReadArgs("session_ABC123")).toEqual(
        expect.arrayContaining(["--teleport", "--model", "haiku", "--max-turns", "--tools", ""]),
      );
      expect(h.commands()).toContainEqual({ args: ["purge", "-y", SCRATCH], cwd: SCRATCH });
      // Only the exact project directory named after the read folder goes.
      expect([...h.present]).toEqual([PROJECTS, UNRELATED]);
    }),
);

it.effect("a failed read still removes the folder and any transcript Claude wrote", () =>
  Effect.gen(function* () {
    const h = yield* makeRead({ teleport: "Error: session not found\n" });
    const error = yield* h.service.readSession(LOGIN, ROOT, "session_ABC123").pipe(Effect.flip);
    expect(error.detail).toBe("Claude did not report the session it read.");
    expect([...h.present]).toEqual([PROJECTS, UNRELATED]);
  }),
);

it.effect("a cleanup step that fails once is retried; one that keeps failing fails the read", () =>
  Effect.gen(function* () {
    const once = yield* makeRead({ stuck: (path, attempt) => path === OWNED && attempt === 1 });
    expect((yield* once.service.readSession(LOGIN, ROOT, "session_ABC123")).transcript).toBe(
      TRANSCRIPT,
    );
    expect([...once.present]).toEqual([PROJECTS, UNRELATED]);

    const stuck = yield* makeRead({ stuck: (path) => path === OWNED });
    const error = yield* stuck.service.readSession(LOGIN, ROOT, "session_ABC123").pipe(Effect.flip);
    expect(error.detail).toContain(
      "could not remove the local copy of the cloud session at " + OWNED,
    );
  }),
);

it.effect("a Git check that exits 128 for a config error refuses the read before teleporting", () =>
  Effect.gen(function* () {
    const h = yield* makeRead({ git: ["broken"] });
    const error = yield* h.service.readSession(LOGIN, ROOT, "session_ABC123").pipe(Effect.flip);
    expect(error.detail).toContain("could not confirm with Git");
    expect(h.commands().some((command) => command.args[0] === "--print")).toBe(false);
    expect(h.present.has(SCRATCH)).toBe(false);
  }),
);

it.effect(
  "a read folder inside a Git checkout moves to the OS temp folder before teleporting",
  () =>
    Effect.gen(function* () {
      const h = yield* makeRead({ git: ["inside", "outside"] });
      yield* h.service.readSession(LOGIN, ROOT, "session_ABC123");
      const teleport = h.commands().find((command) => command.args[0] === "--print");
      expect(teleport?.cwd).toBe("/tmp/goat-claude-cloud-read-AbC123");
      expect(h.present.has(SCRATCH)).toBe(false);
    }),
);

it.effect("an interrupted read still removes everything it copied before it stops", () =>
  Effect.gen(function* () {
    const reading = yield* Deferred.make<void>();
    const h = yield* makeRead({ reading });
    const fiber = yield* h.service
      .readSession(LOGIN, ROOT, "session_ABC123")
      .pipe(Effect.forkChild);
    yield* Deferred.await(reading);
    expect(h.present.has(OWNED)).toBe(true);
    yield* Fiber.interrupt(fiber);
    expect([...h.present]).toEqual([PROJECTS, UNRELATED]);
  }),
);

it.effect("an interruption during cleanup waits for the cleanup to finish", () =>
  Effect.gen(function* () {
    const removing = yield* Deferred.make<void>();
    const h = yield* makeRead({ removing });
    const read = yield* h.service.readSession(LOGIN, ROOT, "session_ABC123").pipe(Effect.forkChild);
    yield* Deferred.await(removing);
    const stop = yield* Fiber.interrupt(read).pipe(Effect.forkChild);
    // adjust runs the interrupting fiber before it wakes the held removal.
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(stop);
    expect([...h.present]).toEqual([PROJECTS, UNRELATED]);
  }),
);
