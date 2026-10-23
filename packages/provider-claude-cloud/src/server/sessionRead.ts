import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { ClaudeCloudLogin, ClaudeCloudRun } from "./cli.ts";
import {
  ClaudeCloudError,
  isClaudeCloudError,
  parseAuthEffect,
  SESSION_ID,
  validateLogin,
} from "./protocol.ts";
import { readTeleportResult } from "./transcript.ts";

/**
 * Reading a cloud session teleports it into a throwaway local fork: Claude copies the cloud
 * transcript into its projects directory and then runs one local turn. That turn is the read's
 * whole cost, so it runs the cheapest model with no tools and a short prompt. The fork never
 * reaches claude.ai, and GOAT deletes it, its project entry and its folder after every read.
 */
export const SESSION_READ_PROMPT = "Reply with OK only.";
export const sessionReadArgs = (sessionId: string) => [
  "--print",
  "--teleport",
  sessionId,
  "--output-format",
  "json",
  "--model",
  "haiku",
  "--max-turns",
  "1",
  "--tools",
  "",
  "--",
  SESSION_READ_PROMPT,
];
const TELEPORT_TIMEOUT = "3 minutes";
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

export interface SessionRead {
  readonly transcript: string;
  readonly costUsd: number | null;
}

const failure = (detail: string, cause?: unknown) =>
  new ClaudeCloudError({
    detail,
    outcome: "uncertain",
    ...(cause === undefined ? {} : { cause }),
  });
const asReadError = (detail: string) => (cause: unknown) =>
  isClaudeCloudError(cause) ? cause : failure(detail, cause);

/** The scratch folder's name as it appears in Claude's per-folder project directory name. */
const scratchToken = (directory: string) =>
  (directory.split(/[\\/]/).at(-1) ?? "").replace(/[^A-Za-z0-9]/g, "-");

export const makeSessionRead = (deps: {
  readonly run: ClaudeCloudRun;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) => {
  const { fileSystem, path } = deps;
  /** Teleport resolves the session's repository from the folder; it must never find a checkout. */
  const insideGitWorkTree = (login: ClaudeCloudLogin, cwd: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const env = yield* Effect.try(() => validateLogin(login));
        const child = yield* deps.spawner.spawn(
          ChildProcess.make("git", ["rev-parse", "--is-inside-work-tree"], {
            cwd,
            env,
            shell: false,
            stdin: "ignore",
          }),
        );
        return Number(yield* child.exitCode) === 0;
      }),
    ).pipe(
      Effect.timeout("10 seconds"),
      // Without Git, teleport cannot resolve a checkout either. A login error surfaces on the read.
      Effect.orElseSucceed(() => false),
    );
  const scratch = Effect.fn("ClaudeCloudCli.readScratch")(function* (
    login: ClaudeCloudLogin,
    root: string,
  ) {
    yield* fileSystem.makeDirectory(root, { recursive: true });
    const preferred = yield* fileSystem.makeTempDirectory({ directory: root, prefix: "read-" });
    if (!(yield* insideGitWorkTree(login, preferred))) return preferred;
    yield* fileSystem.remove(preferred, { recursive: true });
    // A development state directory lives inside its checkout; fall back to the OS temp folder.
    const fallback = yield* fileSystem.makeTempDirectory({ prefix: "goat-claude-cloud-read-" });
    if (!(yield* insideGitWorkTree(login, fallback))) return fallback;
    yield* fileSystem.remove(fallback, { recursive: true });
    return yield* failure("GOAT found no folder outside a Git checkout to read the session in.");
  });

  const cleanup = (
    login: ClaudeCloudLogin,
    directory: string,
    projects: string | undefined,
    found: { readonly folder: string; readonly file: string; readonly id: string } | undefined,
  ) => {
    const token = scratchToken(directory);
    // Each step runs even when an earlier one fails, so no transcript copy outlives the read.
    return Effect.forEach(
      [
        // purge also drops the folder's entry from Claude's global config. Older CLIs lack it.
        deps
          .run(login, directory, ["--help"])
          .pipe(
            Effect.flatMap((help) =>
              /^\s*purge\b/m.test(help.stdout)
                ? deps.run(login, directory, ["purge", "-y", directory])
                : Effect.void,
            ),
          ),
        projects === undefined || token.length < 10
          ? Effect.void
          : fileSystem.readDirectory(projects).pipe(
              Effect.flatMap((entries) =>
                Effect.forEach(
                  entries.filter((entry) => entry.includes(token)),
                  (entry) => fileSystem.remove(path.join(projects, entry), { recursive: true }),
                  { discard: true },
                ),
              ),
            ),
        found === undefined || path.basename(found.folder).includes(token)
          ? Effect.void
          : Effect.all([
              fileSystem.remove(found.file, { force: true }),
              fileSystem.remove(path.join(found.folder, found.id), {
                recursive: true,
                force: true,
              }),
            ]),
      ],
      (step) => Effect.ignore(step),
      { discard: true },
    ).pipe(
      Effect.andThen(Effect.ignore(fileSystem.remove(directory, { recursive: true, force: true }))),
    );
  };

  return Effect.fn("ClaudeCloudCli.readSession")(function* (
    login: ClaudeCloudLogin,
    root: string,
    sessionId: string,
  ) {
    if (!SESSION_ID.test(sessionId))
      return yield* failure("The saved Claude session ID is invalid; GOAT will not read it.");
    const directory = yield* scratch(login, root).pipe(
      Effect.mapError(
        asReadError("GOAT could not create a private folder to read the session in."),
      ),
    );
    let projects: string | undefined;
    let found: { folder: string; file: string; id: string } | undefined;
    return yield* Effect.gen(function* () {
      const auth = yield* deps.run(login, directory, ["auth", "status"]);
      const account = yield* parseAuthEffect(auth.stdout).pipe(
        Effect.mapError((cause) => failure("Claude auth status did not return valid JSON.", cause)),
      );
      const directoryOfProjects = account.projectsDirectory;
      if (!directoryOfProjects)
        return yield* failure(
          "This Claude CLI does not report its projects directory. Update the sibling Claude CLI.",
        );
      projects = directoryOfProjects;
      const reply = yield* deps.run(login, directory, sessionReadArgs(sessionId), {
        timeout: TELEPORT_TIMEOUT,
      });
      const result = readTeleportResult(reply.stdout);
      if (!result) return yield* failure("Claude did not report the session it read.");
      const name = result.localSessionId + ".jsonl";
      const token = scratchToken(directory);
      const entries = (yield* fileSystem.readDirectory(directoryOfProjects)).toSorted(
        (left, right) => Number(right.includes(token)) - Number(left.includes(token)),
      );
      for (const entry of entries) {
        const file = path.join(directoryOfProjects, entry, name);
        if (yield* fileSystem.exists(file)) {
          found = {
            folder: path.join(directoryOfProjects, entry),
            file,
            id: result.localSessionId,
          };
          break;
        }
      }
      if (!found) return yield* failure("Claude did not write the session transcript GOAT reads.");
      const info = yield* fileSystem.stat(found.file);
      if (Number(info.size) > MAX_TRANSCRIPT_BYTES)
        return yield* failure("The session transcript is too large for GOAT to read.");
      const transcript = yield* fileSystem.readFileString(found.file);
      return { transcript, costUsd: result.costUsd } satisfies SessionRead;
    }).pipe(
      Effect.mapError(asReadError("GOAT could not read the session transcript Claude wrote.")),
      Effect.ensuring(Effect.suspend(() => cleanup(login, directory, projects, found))),
    );
  });
};
