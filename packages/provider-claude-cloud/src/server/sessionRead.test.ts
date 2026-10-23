import { expect, it } from "@effect/vitest";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
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
    readonly git?: ReadonlyArray<number>;
    readonly stuck?: (path: string, attempt: number) => boolean;
  } = {},
) =>
  Effect.gen(function* () {
    // A small file tree: Claude's teleport writes the owned project directory and transcript.
    const present = new Set([PROJECTS, UNRELATED]);
    const attempts = new Map<string, number>();
    const git = [...(options.git ?? [128])];
    const h = yield* makeCliHarness(
      (args) => {
        if (args[0] === "rev-parse") return { code: git.shift() ?? 128, stdout: "" };
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
          readFileString: () => Effect.succeed(TRANSCRIPT),
          remove: (target) =>
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

it.effect("an inconclusive Git check refuses the read before anything is teleported", () =>
  Effect.gen(function* () {
    const h = yield* makeRead({ git: [1] });
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
      const h = yield* makeRead({ git: [0, 128] });
      yield* h.service.readSession(LOGIN, ROOT, "session_ABC123");
      const teleport = h.commands().find((command) => command.args[0] === "--print");
      expect(teleport?.cwd).toBe("/tmp/goat-claude-cloud-read-AbC123");
      expect(h.present.has(SCRATCH)).toBe(false);
    }),
);
