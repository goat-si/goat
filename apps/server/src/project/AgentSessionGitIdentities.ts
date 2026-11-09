import type { AgentSessionProjectGit } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import { isBareGitConfig, parseOriginUrlFromGitConfig } from "@goat/shared/git";
import { repositoryPathFromRemoteUrl } from "@goat/source-control-core/server/SourceControlProvider";

import type * as ProcessRunner from "../processRunner.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

export type AgentSessionGitIdentity =
  | { readonly _tag: "Repository"; readonly git: AgentSessionProjectGit | null }
  | { readonly _tag: "Worktree" }
  | { readonly _tag: "NotGit" };

/** open() of a file under macOS privacy protection waits on a consent prompt that a headless server never gets. */
const GIT_FILE_READ_DEADLINE = "2 seconds";
const MAX_GIT_FILE_BYTES = 1024 * 1024;
// Reads run concurrently, so each phase waits one deadline per batch of this many blocked files.
const GIT_FILE_READ_CONCURRENCY = 16;
// A blocked path is skipped for a while, then read again in case it was fixed.
const BLOCKED_GIT_FILE_RETRY_MS = 5 * 60 * 1000;
const MAX_BLOCKED_GIT_FILE_PATHS = 1024;

export function makeGitIdentityReader(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly path: Path.Path;
  readonly isWindows: boolean;
}) {
  const statOption = (target: string) =>
    input.fileSystem.stat(target).pipe(Effect.asSome, Effect.orElseSucceed(Option.none));
  // Paths whose own read outlived the deadline, mapped to when they may be read again.
  const blockedGitFilePaths = new Map<string, number>();

  /** Reads small files without the libuv pool; "" when missing, unreadable or blocked. */
  const readGitFiles = Effect.fn("AgentSessionScanner.readGitFiles")(function* (
    filePaths: ReadonlyArray<string>,
  ) {
    const unique = Array.from(new Set(filePaths));
    const now = yield* Clock.currentTimeMillis;
    const contents = yield* Effect.forEach(
      unique,
      (filePath) => {
        // No privacy prompts or FIFOs to block open() here.
        if (input.isWindows) {
          return input.fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
        }
        if ((blockedGitFilePaths.get(filePath) ?? 0) > now) return Effect.succeed("");
        blockedGitFilePaths.delete(filePath);
        return input.processRunner
          .run({
            command: "cat",
            args: ["--", filePath],
            timeout: GIT_FILE_READ_DEADLINE,
            timeoutBehavior: "timedOutResult",
            maxOutputBytes: MAX_GIT_FILE_BYTES,
            outputMode: "truncate",
          })
          .pipe(Effect.orElseSucceed((): string => ""));
      },
      { concurrency: input.isWindows ? 1 : GIT_FILE_READ_CONCURRENCY },
    ).pipe(
      Effect.map((results) =>
        results.flatMap((result, index): Array<readonly [string, string]> => {
          const filePath = unique[index];
          if (filePath === undefined) return [];
          if (typeof result === "string") return [[filePath, result]];
          if (result.timedOut) {
            if (blockedGitFilePaths.size >= MAX_BLOCKED_GIT_FILE_PATHS) {
              const oldest = blockedGitFilePaths.keys().next().value;
              if (oldest !== undefined) blockedGitFilePaths.delete(oldest);
            }
            blockedGitFilePaths.set(filePath, now + BLOCKED_GIT_FILE_RETRY_MS);
          }
          return [[filePath, result.code === 0 ? result.stdout : ""]];
        }),
      ),
    );
    return new Map(contents);
  });

  /** Reads every directory's git identity in three phases of concurrent reads. */
  return Effect.fn("AgentSessionScanner.readGitIdentities")(function* (
    directories: ReadonlyArray<string>,
  ) {
    const identities = new Map<string, AgentSessionGitIdentity>();
    const repositories: Array<{ directory: string; gitDir: string; linkedWorktree: boolean }> = [];
    const pointers: Array<{ directory: string; gitPath: string }> = [];
    for (const directory of directories) {
      const gitPath = input.path.join(directory, ".git");
      const gitStats = yield* statOption(gitPath);
      if (Option.isNone(gitStats)) identities.set(directory, { _tag: "NotGit" });
      else if (gitStats.value.type === "Directory") {
        repositories.push({ directory, gitDir: gitPath, linkedWorktree: false });
      } else pointers.push({ directory, gitPath });
    }

    const pointerTexts = yield* readGitFiles(pointers.map(({ gitPath }) => gitPath));
    const linkedWorktrees: Array<{ directory: string; gitDir: string }> = [];
    for (const { directory, gitPath } of pointers) {
      const target = /^gitdir:\s*(.+)$/m.exec(pointerTexts.get(gitPath) ?? "")?.[1]?.trim();
      if (target === undefined || target.length === 0) {
        identities.set(directory, { _tag: "NotGit" });
        continue;
      }
      const gitDir = input.path.resolve(directory, target);
      if (/[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(gitDir)) {
        linkedWorktrees.push({ directory, gitDir });
      } else repositories.push({ directory, gitDir, linkedWorktree: false });
    }

    const commonDirTexts = yield* readGitFiles(
      linkedWorktrees.map(({ gitDir }) => input.path.join(gitDir, "commondir")),
    );
    for (const { directory, gitDir } of linkedWorktrees) {
      const commonDir = (commonDirTexts.get(input.path.join(gitDir, "commondir")) ?? "").trim();
      if (commonDir.length === 0) identities.set(directory, { _tag: "Worktree" });
      else
        repositories.push({
          directory,
          gitDir: input.path.resolve(gitDir, commonDir),
          linkedWorktree: true,
        });
    }

    const configTexts = yield* readGitFiles(
      repositories.map(({ gitDir }) => input.path.join(gitDir, "config")),
    );
    for (const { directory, gitDir, linkedWorktree } of repositories) {
      const configText = configTexts.get(input.path.join(gitDir, "config")) ?? "";
      // Bare repositories have no main checkout, so offer their linked worktrees independently.
      if (linkedWorktree && !isBareGitConfig(configText)) {
        identities.set(directory, { _tag: "Worktree" });
        continue;
      }
      const originUrl = parseOriginUrlFromGitConfig(configText);
      identities.set(directory, {
        _tag: "Repository",
        git: {
          remoteKey:
            originUrl === null ? null : sourceControlDefinitions.repositoryKeyFromRemote(originUrl),
          repository: repositoryPathFromRemoteUrl(originUrl),
        },
      });
    }
    return identities;
  });
}
