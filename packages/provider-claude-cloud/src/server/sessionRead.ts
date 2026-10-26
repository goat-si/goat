import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { collectUint8StreamText } from "@goat/provider-core/server/collectStreamText";
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
const SESSION_READ_PROMPT = "Reply with OK only.";
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

/** Claude names a folder's project directory after its path with every other character a dash. */
const projectSlug = (directory: string) => directory.replace(/[^A-Za-z0-9]/g, "-");

export const makeSessionRead = (deps: {
  readonly run: ClaudeCloudRun;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) => {
  const { fileSystem, path } = deps;
  /**
   * Teleport resolves the session's repository from its folder, so it must never run inside a
   * checkout. Only Git's own "not a git repository" diagnostic counts as outside: Git also exits
   * 128 for broken config or unsafe ownership, which say nothing about the folder. The probe runs
   * in the C locale so the diagnostic is never translated.
   */
  const outsideGit = (login: ClaudeCloudLogin, cwd: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const env = yield* Effect.try(() => validateLogin(login));
        const child = yield* deps.spawner.spawn(
          ChildProcess.make("git", ["rev-parse", "--is-inside-work-tree"], {
            cwd,
            env: { ...env, LC_ALL: "C", LANGUAGE: "C" },
            shell: false,
            stdin: "ignore",
          }),
        );
        const [code, stdout, stderr] = yield* Effect.all(
          [
            child.exitCode,
            collectUint8StreamText({ stream: child.stdout, maxBytes: 4096 }),
            collectUint8StreamText({ stream: child.stderr, maxBytes: 4096 }),
          ],
          { concurrency: "unbounded" },
        );
        if (Number(code) === 128 && /^fatal: not a git repository\b/m.test(stderr.text))
          return "outside" as const;
        if (Number(code) === 0 && stdout.text.trim() === "true") return "inside" as const;
        return "unknown" as const;
      }),
    ).pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => "unknown" as const),
    );
  const scratch = Effect.fn("ClaudeCloudCli.readScratch")(function* (
    login: ClaudeCloudLogin,
    root: string,
  ) {
    yield* fileSystem.makeDirectory(root, { recursive: true });
    const preferred = yield* fileSystem.makeTempDirectory({ directory: root, prefix: "read-" });
    const first = yield* outsideGit(login, preferred);
    if (first === "outside") return preferred;
    yield* fileSystem.remove(preferred, { recursive: true });
    if (first === "unknown")
      return yield* failure(
        "GOAT could not confirm with Git that its read folder is outside a checkout.",
      );
    // A development state directory lives inside its checkout; fall back to the OS temp folder.
    const fallback = yield* fileSystem.makeTempDirectory({ prefix: "goat-claude-cloud-read-" });
    if ((yield* outsideGit(login, fallback)) === "outside") return fallback;
    yield* fileSystem.remove(fallback, { recursive: true });
    return yield* failure("GOAT found no folder outside a Git checkout to read the session in.");
  });

  /**
   * Removes everything this read owns: its folder, the project directories Claude named after
   * exactly that folder, and the transcript it wrote. Every step runs even if another fails, a
   * second pass retries what is left, and the paths still present are returned.
   */
  const cleanup = Effect.fn("ClaudeCloudCli.readCleanup")(function* (
    login: ClaudeCloudLogin,
    directory: string,
    owned: ReadonlyArray<string>,
    found: { readonly file: string; readonly sidecar: string } | undefined,
  ) {
    // purge also drops the folder's entry from Claude's global config. Older CLIs lack it.
    yield* deps.run(login, directory, ["--help"]).pipe(
      Effect.flatMap((help) =>
        /^\s*purge\b/m.test(help.stdout)
          ? deps.run(login, directory, ["purge", "-y", directory])
          : Effect.void,
      ),
      Effect.ignore,
    );
    const targets = [...owned, ...(found ? [found.file, found.sidecar] : []), directory];
    const left = () =>
      Effect.filter(targets, (target) =>
        fileSystem.exists(target).pipe(Effect.orElseSucceed(() => true)),
      );
    for (let pass = 0; pass < 2; pass++) {
      const remaining = yield* left();
      if (remaining.length === 0) return [];
      yield* Effect.forEach(
        remaining,
        (target) => Effect.ignore(fileSystem.remove(target, { recursive: true, force: true })),
        { discard: true },
      );
    }
    return yield* left();
  });

  const readIn = Effect.fn("ClaudeCloudCli.readIn")(function* (
    login: ClaudeCloudLogin,
    directory: string,
    sessionId: string,
    owns: (paths: { owned?: string[]; found?: { file: string; sidecar: string } }) => void,
  ) {
    const auth = yield* deps.run(login, directory, ["auth", "status"]);
    const account = yield* parseAuthEffect(auth.stdout).pipe(
      Effect.mapError((cause) => failure("Claude auth status did not return valid JSON.", cause)),
    );
    const projects = account.projectsDirectory;
    if (!projects)
      return yield* failure(
        "This Claude CLI does not report its projects directory. Update the sibling Claude CLI.",
      );
    const real = yield* fileSystem.realPath(directory).pipe(Effect.orElseSucceed(() => directory));
    owns({
      owned: [...new Set([directory, real])].map((folder) =>
        path.join(projects, projectSlug(folder)),
      ),
    });
    const reply = yield* deps.run(login, directory, sessionReadArgs(sessionId), {
      timeout: TELEPORT_TIMEOUT,
    });
    const result = readTeleportResult(reply.stdout);
    if (!result) return yield* failure("Claude did not report the session it read.");
    const name = result.localSessionId + ".jsonl";
    // The fork's ID is new and unique, so the folder holding it is this read's even when
    // Claude shortened the folder's name.
    let found: { file: string; sidecar: string } | undefined;
    for (const entry of yield* fileSystem.readDirectory(projects)) {
      const file = path.join(projects, entry, name);
      if (yield* fileSystem.exists(file)) {
        found = { file, sidecar: path.join(projects, entry, result.localSessionId) };
        owns({ found });
        break;
      }
    }
    if (!found) return yield* failure("Claude did not write the session transcript GOAT reads.");
    const info = yield* fileSystem.stat(found.file);
    if (Number(info.size) > MAX_TRANSCRIPT_BYTES)
      return yield* failure("The session transcript is too large for GOAT to read.");
    const transcript = yield* fileSystem.readFileString(found.file);
    return { transcript, costUsd: result.costUsd } satisfies SessionRead;
  });

  return Effect.fn("ClaudeCloudCli.readSession")(function* (
    login: ClaudeCloudLogin,
    root: string,
    sessionId: string,
  ) {
    if (!SESSION_ID.test(sessionId))
      return yield* failure("The saved Claude session ID is invalid; GOAT will not read it.");
    // From the moment the folder exists until its cleanup is verified, nothing may interrupt:
    // only the read itself can be cut short, and cleanup always follows it.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const directory = yield* scratch(login, root).pipe(
          Effect.mapError(
            asReadError("GOAT could not create a private folder to read the session in."),
          ),
        );
        let owned: string[] = [];
        let found: { file: string; sidecar: string } | undefined;
        const exit = yield* restore(
          readIn(login, directory, sessionId, (paths) => {
            if (paths.owned) owned = paths.owned;
            if (paths.found) found = paths.found;
          }),
        ).pipe(
          Effect.mapError(asReadError("GOAT could not read the session transcript Claude wrote.")),
          Effect.exit,
        );
        const left = yield* cleanup(login, directory, owned, found);
        if (left.length > 0)
          return yield* failure(
            "GOAT could not remove the local copy of the cloud session at " +
              left.join(", ") +
              ". Delete it by hand.",
          );
        return yield* exit;
      }),
    );
  });
};
