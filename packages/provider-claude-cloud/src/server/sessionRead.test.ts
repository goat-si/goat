import { expect, it } from "@effect/vitest";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
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
const SLUG = "-fixture-goat-reads-read-AbC123";
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
  dev: 0,
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

const makeRead = (options: { readonly teleport?: string; readonly checkouts?: number } = {}) =>
  Effect.gen(function* () {
    const removed: string[] = [];
    let checkouts = options.checkouts ?? 0;
    const h = yield* makeCliHarness(
      (args) => {
        if (args[0] === "rev-parse") return { code: checkouts-- > 0 ? 0 : 128, stdout: "" };
        if (args[0] === "auth")
          return {
            code: 0,
            stdout: JSON.stringify({
              loggedIn: true,
              authMethod: "claude.ai",
              projectsDirectory: PROJECTS,
            }),
          };
        if (args[0] === "--print") return { code: 0, stdout: options.teleport ?? TELEPORT_RESULT };
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
            Effect.succeed((input?.directory ?? "/tmp") + "/" + (input?.prefix ?? "") + "AbC123"),
          readDirectory: () => Effect.succeed(["-Users-dev-other-project", SLUG]),
          exists: (path) => Effect.succeed(path === PROJECTS + "/" + SLUG + "/" + FORK + ".jsonl"),
          stat: () => Effect.succeed(info),
          readFileString: () => Effect.succeed(TRANSCRIPT),
          remove: (path) =>
            Effect.sync(() => {
              removed.push(path);
            }),
        },
      },
    );
    const commands = () =>
      h.commands.map((command) => ({ args: command.args, cwd: command.options.cwd }));
    return { service: h.service, removed, commands };
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
      expect(h.removed).toEqual([PROJECTS + "/" + SLUG, SCRATCH]);
    }),
);

it.effect("a failed read still removes the folder and any transcript Claude wrote", () =>
  Effect.gen(function* () {
    const h = yield* makeRead({ teleport: "Error: session not found\n" });
    const error = yield* h.service.readSession(LOGIN, ROOT, "session_ABC123").pipe(Effect.flip);
    expect(error.detail).toBe("Claude did not report the session it read.");
    expect(h.removed).toEqual([PROJECTS + "/" + SLUG, SCRATCH]);
  }),
);

it.effect(
  "a read folder inside a Git checkout moves to the OS temp folder before teleporting",
  () =>
    Effect.gen(function* () {
      const h = yield* makeRead({ checkouts: 1 });
      yield* h.service.readSession(LOGIN, ROOT, "session_ABC123");
      const teleport = h.commands().find((command) => command.args[0] === "--print");
      expect(teleport?.cwd).toBe("/tmp/goat-claude-cloud-read-AbC123");
      expect(h.removed[0]).toBe(SCRATCH);
    }),
);
