import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { makeTempDir, writeTranscript, runRecentThreads } from "./AgentSessionScanner.testkit.ts";

const encodeTranscriptRecord = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
it.layer(NodeServices.layer)("large image session import", (it) => {
  it.effect("imports a Claude session whose first prompt carries an image over 1 MiB", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const claudeHomePath = yield* makeTempDir("goat-large-image-claude-");
      const codexHomePath = yield* makeTempDir("goat-large-image-codex-");
      const workspace = yield* makeTempDir("goat-large-image-workspace-");
      const sessionId = "large-image-session";
      const contents = [
        { type: "queue-operation", operation: "enqueue", sessionId },
        { type: "queue-operation", operation: "dequeue", sessionId },
        {
          type: "user",
          cwd: workspace,
          sessionId,
          timestamp: "2026-08-24T10:00:00.000Z",
          message: {
            role: "user",
            content: [
              { type: "text", text: "Look at this screenshot" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "A".repeat(1_100 * 1024),
                },
              },
            ],
          },
        },
        {
          type: "assistant",
          sessionId,
          timestamp: "2026-08-24T10:01:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
        },
      ]
        .map((record) => encodeTranscriptRecord(record))
        .join("\n");
      yield* writeTranscript({
        filePath: path.join(claudeHomePath, "projects", "-large-image", `${sessionId}.jsonl`),
        contents,
        mtimeMs: nowMs - 60 * 60 * 1000,
      });

      const threads = yield* runRecentThreads({
        claudeHomePath,
        codexHomePath,
        workspaceRoot: workspace,
      });

      expect(threads.map((thread) => thread.providerSessionId)).toEqual([sessionId]);
    }),
  );
});
