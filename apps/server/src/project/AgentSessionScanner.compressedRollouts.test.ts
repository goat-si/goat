import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { makeTempDir, runRecentThreads, runScan } from "./AgentSessionScanner.testkit.ts";

const encodeTranscriptRecord = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const codexRolloutLine = (cwd: string) =>
  `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { id: "r1", cwd } })}\n`;

const writeCompressedTranscript = Effect.fn("AgentSessionScanner.test.writeCompressedTranscript")(
  function* (input: {
    readonly filePath: string;
    readonly contents: string;
    readonly mtimeMs: number;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(input.filePath), { recursive: true });
    yield* fileSystem.writeFile(input.filePath, NodeZlib.zstdCompressSync(input.contents));
    const seconds = input.mtimeMs / 1000;
    yield* fileSystem.utimes(input.filePath, seconds, seconds);
  },
);

it.layer(NodeServices.layer)("AgentSessionScanner compressed Codex rollouts", (it) => {
  describe("scan", () => {
    it.effect("discovers projects whose Codex rollouts are zstd-compressed", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const claudeHomePath = yield* makeTempDir("goat-claude-home-");
        const codexHomePath = yield* makeTempDir("goat-codex-home-");
        const workspace = yield* makeTempDir("goat-workspace-");
        yield* writeCompressedTranscript({
          filePath: path.join(
            codexHomePath,
            "sessions",
            "2026",
            "05",
            "03",
            "rollout-2026-05-03T00-00-00-019a5f00-0000-7000-8000-00000000000b.jsonl.zst",
          ),
          contents: codexRolloutLine(workspace),
          mtimeMs: Date.parse("2026-05-03T00:00:00.000Z"),
        });

        const result = yield* runScan({ claudeHomePath, codexHomePath });

        expect(result.candidates.map(({ path, threadCount }) => ({ path, threadCount }))).toEqual([
          { path: workspace, threadCount: 1 },
        ]);
      }),
    );
  });

  describe("recentThreads", () => {
    it.effect("imports Codex conversations stored only as zstd-compressed rollouts", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("goat-claude-home-");
        const codexHomePath = yield* makeTempDir("goat-codex-home-");
        const workspace = yield* makeTempDir("goat-workspace-");
        yield* writeCompressedTranscript({
          filePath: path.join(
            codexHomePath,
            "sessions",
            "2026",
            "08",
            "20",
            "rollout-2026-08-20T10-00-00-019a5f00-0000-7000-8000-00000000000c.jsonl.zst",
          ),
          contents: [
            encodeTranscriptRecord({
              type: "session_meta",
              payload: { id: "019a5f00-0000-7000-8000-00000000000c", cwd: workspace },
            }),
            encodeTranscriptRecord({
              type: "event_msg",
              timestamp: "2026-08-20T10:00:00.000Z",
              payload: { type: "user_message", message: "Compressed prompt" },
            }),
            encodeTranscriptRecord({
              type: "response_item",
              timestamp: "2026-08-20T10:01:00.000Z",
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Compressed answer" }],
              },
            }),
          ].join("\n"),
          mtimeMs: nowMs - 4 * 24 * 60 * 60 * 1000,
        });

        const threads = yield* runRecentThreads({
          claudeHomePath,
          codexHomePath,
          workspaceRoot: workspace,
        });

        expect(
          threads.map((thread) => ({
            id: thread.providerSessionId,
            messages: thread.messages.map((message) => message.text),
          })),
        ).toEqual([
          {
            id: "019a5f00-0000-7000-8000-00000000000c",
            messages: ["Compressed prompt", "Compressed answer"],
          },
        ]);
      }),
    );
  });
});
