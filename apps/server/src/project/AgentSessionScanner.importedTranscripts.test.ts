import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { AgentSessionImportSource } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import { layerScannerTest, makeTempDir, writeTranscript } from "./AgentSessionScanner.testkit.ts";

const decodeImportSource = Schema.decodeUnknownSync(AgentSessionImportSource);

const encodeTranscriptRecord = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("AgentSessionScanner imported transcripts", (it) => {
  describe("recentThreads", () => {
    it.effect("excludes Codex subagents from discovery and the recent-thread budget", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("goat-claude-home-");
        const codexHomePath = yield* makeTempDir("goat-codex-home-");
        const workspace = yield* makeTempDir("goat-workspace-");
        const subagentSources = [
          { subagent: { thread_spawn: { parent_thread_id: "session-100", depth: 1 } } },
          { subagent: "review" },
          { subagent: { other: "guardian" } },
          { subAgent: "compact" },
        ];
        // Newer subagents would exhaust the 100-transcript import budget before any parent.
        const sources = [
          ...Array.from({ length: 100 }, (_, index) => subagentSources[index % 4]),
          "vscode",
          undefined,
          null,
          { custom: "launcher" },
        ];
        const fileSystem = yield* FileSystem.FileSystem;
        // Rollouts imported before subagents were excluded still have import records.
        const legacyImports: Array<AgentSessionImportSource> = [];
        for (const [index, source] of sources.entries()) {
          const filePath = path.join(
            codexHomePath,
            "sessions",
            "2026",
            "08",
            "24",
            `rollout-${index}.jsonl`,
          );
          yield* writeTranscript({
            filePath,
            contents: [
              { type: "session_meta", payload: { id: `session-${index}`, cwd: workspace, source } },
              // A later cwd must not make an excluded rollout eligible again.
              { type: "turn_context", payload: { cwd: workspace } },
              {
                type: "event_msg",
                payload: { type: "user_message", message: "Import this prompt" },
              },
            ]
              .map((record) => encodeTranscriptRecord(record))
              .join("\n"),
            mtimeMs: nowMs - index * 60_000,
          });
          if (index >= 100) continue;
          const stats = yield* fileSystem.stat(filePath);
          legacyImports.push(
            decodeImportSource({
              provider: "codex",
              providerInstanceId: "codex",
              providerSessionId: `session-${index}`,
              filePath,
              size: Number(stats.size),
              mtimeMs: Option.getOrNull(Option.map(stats.mtime, (date) => date.getTime())),
              device: Number(stats.dev),
              inode: Option.getOrNull(Option.map(stats.ino, String)),
              birthtimeMs: Option.getOrNull(Option.map(stats.birthtime, (date) => date.getTime())),
            }),
          );
        }

        yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          const scan = yield* scanner.scan({ includePi: true });
          expect.soft(scan.candidates.map((candidate) => candidate.threadCount)).toEqual([4]);
          const outcomes = yield* Stream.runCollect(scanner.recentThreads(workspace));
          expect(
            outcomes.map((outcome) =>
              outcome._tag === "Importable" ? outcome.thread.providerSessionId : outcome._tag,
            ),
          ).toEqual(["session-100", "session-101", "session-102", "session-103"]);
        }).pipe(
          Effect.provide(
            layerScannerTest({
              claudeHomePath,
              codexHomePath,
              importedTranscripts: { cwd: workspace, sources: legacyImports },
            }),
          ),
        );
      }),
    );

    it.effect("repeated imports reach older transcripts behind already-imported ones", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("goat-repeat-import-claude-");
        const codexHomePath = yield* makeTempDir("goat-repeat-import-codex-");
        const workspace = yield* makeTempDir("goat-repeat-import-workspace-");
        const sessionIds = Array.from(
          { length: 102 },
          (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        );
        for (const [index, sessionId] of sessionIds.entries()) {
          yield* writeTranscript({
            filePath: path.join(claudeHomePath, "projects", "p", `${sessionId}.jsonl`),
            // 999 cwd-less records cost 1,000 metadata records, so 100 newer transcripts
            // exhaust MAX_METADATA_RECORDS_PER_SOURCE.
            contents:
              "{}\n".repeat(999) +
              `${encodeTranscriptRecord({
                type: "user",
                cwd: workspace,
                sessionId,
                timestamp: "2026-08-23T12:00:00.000Z",
                message: { role: "user", content: `Prompt ${index}` },
              })}\n`,
            mtimeMs: nowMs - (index + 1) * 60_000,
          });
        }

        const completed: Array<AgentSessionImportSource> = [];
        const imported = yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          while (true) {
            const outcomes = yield* scanner
              .recentThreads(workspace, completed)
              .pipe(Stream.runCollect);
            const added = Array.from(outcomes).flatMap((outcome) =>
              outcome._tag === "Importable" ? [outcome.source] : [],
            );
            if (added.length === 0) return completed;
            completed.push(...added);
          }
        }).pipe(
          Effect.provide(
            layerScannerTest({
              claudeHomePath,
              codexHomePath,
              importedTranscripts: { cwd: workspace, sources: completed },
            }),
          ),
        );

        expect(imported.map((source) => source.providerSessionId).toSorted()).toEqual(sessionIds);
      }),
    );

    it.effect("lists projects whose transcripts sit behind already-imported ones", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("goat-hidden-project-claude-");
        const codexHomePath = yield* makeTempDir("goat-hidden-project-codex-");
        const imported = yield* makeTempDir("goat-hidden-project-imported-");
        const hidden = yield* makeTempDir("goat-hidden-project-hidden-");
        const hiddenSessionId = "00000000-0000-4000-8000-000000000100";
        for (const index of Array.from({ length: 101 }, (_, value) => value)) {
          const sessionId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
          yield* writeTranscript({
            filePath: path.join(claudeHomePath, "projects", "p", `${sessionId}.jsonl`),
            contents:
              "{}\n".repeat(999) +
              `${encodeTranscriptRecord({
                type: "user",
                cwd: index === 100 ? hidden : imported,
                sessionId,
                message: { role: "user", content: `Prompt ${index}` },
              })}\n`,
            mtimeMs: nowMs - (index + 1) * 60_000,
          });
        }

        const completed: Array<AgentSessionImportSource> = [];
        const scans = yield* Effect.gen(function* () {
          const scanner = yield* AgentSessionScanner.AgentSessionScanner;
          const before = yield* scanner.scan({ includePi: true });
          const outcomes = yield* scanner.recentThreads(imported).pipe(Stream.runCollect);
          const sources = Array.from(outcomes).flatMap((outcome) =>
            outcome._tag === "Importable" ? [outcome.source] : [],
          );
          // A record whose file identity no longer matches must not lend its cwd.
          const newest = sources[0]!;
          completed.push(...sources, {
            ...newest,
            providerSessionId: hiddenSessionId,
            filePath: path.join(claudeHomePath, "projects", "p", `${hiddenSessionId}.jsonl`),
          });
          return { before, after: yield* scanner.scan({ includePi: true }) };
        }).pipe(
          Effect.provide(
            layerScannerTest({
              claudeHomePath,
              codexHomePath,
              importedTranscripts: { cwd: imported, sources: completed },
            }),
          ),
        );

        expect(scans.before.candidates.map((candidate) => candidate.path)).toEqual([imported]);
        expect(scans.after.candidates.map((candidate) => candidate.path)).toEqual([
          imported,
          hidden,
        ]);
      }),
    );
  });
});
