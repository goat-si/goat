import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const makeTempDir = Effect.fn("test.makeTempDir")(function* (prefix: string) {
  return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix });
});
const writeTranscript = Effect.fn("test.writeTranscript")(function* (input: {
  filePath: string;
  contents: string;
  mtimeMs: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(input.filePath), { recursive: true });
  yield* fs.writeFileString(input.filePath, input.contents);
  yield* fs.utimes(input.filePath, input.mtimeMs / 1000, input.mtimeMs / 1000);
});
const encodeTranscriptRecord = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const runRecentThreads = (input: {
  claudeHomePath: string;
  codexHomePath: string;
  workspaceRoot: string;
}) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    const outcomes = yield* scanner
      .recentThreads(input.workspaceRoot, [], { includePi: true })
      .pipe(Stream.runCollect);
    return Array.from(outcomes);
  }).pipe(
    Effect.provide(
      AgentSessionScanner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({
              providerInstances: {
                [ProviderInstanceId.make("claudeAgent")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  config: { homePath: input.claudeHomePath },
                },
                [ProviderInstanceId.make("codex")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: input.codexHomePath },
                },
                [ProviderInstanceId.make("pi")]: {
                  driver: ProviderDriverKind.make("pi"),
                  enabled: true,
                  environment: [
                    {
                      name: "PI_CODING_AGENT_DIR",
                      value: `${input.claudeHomePath}/pi-agent`,
                      sensitive: false,
                    },
                    { name: "PI_CODING_AGENT_SESSION_DIR", value: "", sensitive: false },
                  ],
                  config: {},
                },
              },
            }),
            ServerConfig.layerTest(input.claudeHomePath, { prefix: "goat-scanner-config-" }),
            Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
          ),
        ),
      ),
    ),
  );

it.layer(NodeServices.layer)("Codex inherited history", (it) => {
  it.effect("retries a rewound Codex thread after its missing parent becomes available", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const claudeHomePath = yield* makeTempDir("goat-claude-home-");
      const codexHomePath = yield* makeTempDir("goat-codex-home-");
      const workspace = yield* makeTempDir("goat-workspace-");
      const threadId = "019a0000-0000-7000-8000-000000000001";
      const rolloutId = "019a0000-0000-7000-8000-000000000002";
      const sessionsDir = path.join(codexHomePath, "sessions", "2026", "08", "24");
      const prompt = (message: string) =>
        encodeTranscriptRecord({ type: "event_msg", payload: { type: "user_message", message } });
      const reply = (text: string) =>
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        });
      const keptHistory = [
        encodeTranscriptRecord({
          type: "session_meta",
          payload: { id: threadId, cwd: workspace, history_mode: "paginated" },
        }),
        prompt("Keep the first request"),
        reply("First reply"),
      ]
        .map((record) => `${record}\n`)
        .join("");

      yield* writeTranscript({
        filePath: path.join(
          sessionsDir,
          `rollout-2026-08-24T11-00-00-${threadId}_${rolloutId}.jsonl`,
        ),
        contents: [
          encodeTranscriptRecord({
            type: "session_meta",
            payload: {
              id: threadId,
              cwd: workspace,
              history_mode: "paginated",
              history_base: {
                thread_id: threadId,
                end_ordinal_exclusive: 3,
                end_byte_offset: Buffer.byteLength(keptHistory),
              },
            },
          }),
          prompt("Ask again"),
          reply("Final reply"),
        ].join("\n"),
        mtimeMs: nowMs,
      });

      const beforeParent = yield* runRecentThreads({
        claudeHomePath,
        codexHomePath,
        workspaceRoot: workspace,
      });
      expect(beforeParent.map((outcome) => outcome._tag)).toEqual(["Skipped"]);

      yield* writeTranscript({
        filePath: path.join(sessionsDir, `rollout-2026-08-24T10-00-00-${threadId}.jsonl`),
        contents: `${keptHistory}${prompt("Rewound request")}\n${reply("Rewound reply")}\n`,
        mtimeMs: nowMs - 60_000,
      });

      const outcomes = yield* runRecentThreads({
        claudeHomePath,
        codexHomePath,
        workspaceRoot: workspace,
      });
      const threads = outcomes.flatMap((outcome) =>
        outcome._tag === "Importable" ? [outcome.thread] : [],
      );

      expect(
        threads.map((thread) => ({
          id: thread.providerSessionId,
          title: thread.title,
          messages: thread.messages.map((message) => message.text),
        })),
      ).toEqual([
        {
          id: threadId,
          title: "Keep the first request",
          messages: ["Keep the first request", "First reply", "Ask again", "Final reply"],
        },
      ]);
    }),
  );
});
