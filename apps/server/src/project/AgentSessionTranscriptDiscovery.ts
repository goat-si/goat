import type { ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import { transcriptIdentity, type TranscriptIdentity } from "./AgentSessionTranscriptIdentity.ts";

export interface TranscriptCandidate {
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly providerInstanceId: ProviderInstanceId;
  readonly homePath: string;
  readonly identity: TranscriptIdentity;
}

export function makeTranscriptDiscovery(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const { fileSystem, path } = input;
  const listDirectory = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  const statOption = (target: string) =>
    fileSystem.stat(target).pipe(Effect.asSome, Effect.orElseSucceed(Option.none));

  const discoverClaudeTranscripts = Effect.fn("AgentSessionScanner.discoverClaudeTranscripts")(
    function* (homePath: string, providerInstanceId: ProviderInstanceId, operationBudget: number) {
      const projectsDir = path.join(homePath, "projects");
      let operationsRemaining = operationBudget;
      let truncated = false;
      const readDirectory = (directory: string) => {
        if (operationsRemaining <= 0) {
          truncated = true;
          return Effect.succeed<ReadonlyArray<string>>([]);
        }
        operationsRemaining -= 1;
        return listDirectory(directory);
      };
      const projectDirectories = yield* readDirectory(projectsDir);
      const transcripts: Array<TranscriptCandidate> = [];

      for (const projectDirectory of projectDirectories) {
        if (operationsRemaining <= 0) {
          truncated = true;
          break;
        }
        const directory = path.join(projectsDir, projectDirectory);
        const directoryTranscripts = (yield* readDirectory(directory))
          .filter((entry) => entry.endsWith(".jsonl"))
          .map((entry) => path.join(directory, entry));

        for (const filePath of directoryTranscripts) {
          if (operationsRemaining <= 0) {
            truncated = true;
            break;
          }
          operationsRemaining -= 1;
          const stats = yield* statOption(filePath);
          if (
            Option.isNone(stats) ||
            stats.value.type !== "File" ||
            Option.isNone(stats.value.mtime)
          ) {
            continue;
          }
          transcripts.push({
            filePath,
            mtimeMs: stats.value.mtime.value.getTime(),
            providerInstanceId,
            homePath,
            identity: transcriptIdentity(filePath, stats.value),
          });
        }
      }
      return { transcripts, truncated };
    },
  );

  const discoverCodexTranscripts = Effect.fn("AgentSessionScanner.discoverCodexTranscripts")(
    function* (homePath: string, providerInstanceId: ProviderInstanceId, operationBudget: number) {
      const sessionsDir = path.join(homePath, "sessions");

      const transcripts: Array<TranscriptCandidate> = [];
      let operationsRemaining = operationBudget;
      let truncated = false;
      const readDirectory = (directory: string) => {
        if (operationsRemaining <= 0) {
          truncated = true;
          return Effect.succeed<ReadonlyArray<string>>([]);
        }
        operationsRemaining -= 1;
        return listDirectory(directory);
      };
      for (const year of (yield* readDirectory(sessionsDir)).toSorted().toReversed()) {
        if (operationsRemaining <= 0) {
          truncated = true;
          break;
        }
        for (const month of (yield* readDirectory(path.join(sessionsDir, year)))
          .toSorted()
          .toReversed()) {
          if (operationsRemaining <= 0) {
            truncated = true;
            break;
          }
          for (const day of (yield* readDirectory(path.join(sessionsDir, year, month)))
            .toSorted()
            .toReversed()) {
            if (operationsRemaining <= 0) {
              truncated = true;
              break;
            }
            const directory = path.join(sessionsDir, year, month, day);
            for (const entry of (yield* readDirectory(directory)).toSorted().toReversed()) {
              if (!entry.startsWith("rollout-") || !entry.endsWith(".jsonl")) continue;
              if (operationsRemaining <= 0) {
                truncated = true;
                break;
              }
              const filePath = path.join(directory, entry);
              operationsRemaining -= 1;
              const stats = yield* statOption(filePath);
              if (
                Option.isSome(stats) &&
                stats.value.type === "File" &&
                Option.isSome(stats.value.mtime)
              ) {
                transcripts.push({
                  filePath,
                  mtimeMs: stats.value.mtime.value.getTime(),
                  providerInstanceId,
                  homePath,
                  identity: transcriptIdentity(filePath, stats.value),
                });
              }
            }
          }
        }
      }
      return { transcripts, truncated };
    },
  );

  // Pi nests sessions in one directory per cwd, but a custom session directory holds them flat.
  const discoverPiTranscripts = Effect.fn("AgentSessionScanner.discoverPiTranscripts")(function* (
    sessionsDir: string,
    providerInstanceId: ProviderInstanceId,
    operationBudget: number,
  ) {
    let operationsRemaining = operationBudget;
    let truncated = false;
    const readDirectory = (directory: string) => {
      if (operationsRemaining <= 0) {
        truncated = true;
        return Effect.succeed<ReadonlyArray<string>>([]);
      }
      operationsRemaining -= 1;
      return listDirectory(directory);
    };
    const transcripts: Array<TranscriptCandidate> = [];
    for (const entry of yield* readDirectory(sessionsDir)) {
      if (operationsRemaining <= 0) {
        truncated = true;
        break;
      }
      const entryPath = path.join(sessionsDir, entry);
      const filePaths = entry.endsWith(".jsonl")
        ? [entryPath]
        : (yield* readDirectory(entryPath))
            .filter((nested) => nested.endsWith(".jsonl"))
            .map((nested) => path.join(entryPath, nested));

      for (const filePath of filePaths) {
        if (operationsRemaining <= 0) {
          truncated = true;
          break;
        }
        operationsRemaining -= 1;
        const stats = yield* statOption(filePath);
        if (
          Option.isSome(stats) &&
          stats.value.type === "File" &&
          Option.isSome(stats.value.mtime)
        ) {
          transcripts.push({
            filePath,
            mtimeMs: stats.value.mtime.value.getTime(),
            providerInstanceId,
            homePath: sessionsDir,
            identity: transcriptIdentity(filePath, stats.value),
          });
        }
      }
    }
    return { transcripts, truncated };
  });

  return { discoverClaudeTranscripts, discoverCodexTranscripts, discoverPiTranscripts };
}
