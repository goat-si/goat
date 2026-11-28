import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CHILD, ROOT } from "./AntigravityChildWork.testkit.ts";
import {
  readAntigravitySubagentTranscript,
  transcriptToSubagentEntries,
} from "./AntigravitySubagentTranscript.ts";

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("AntigravitySubagentTranscript", (it) => {
  // A backtracking parser takes tens of seconds here and trips the test timeout.
  it("parses an unterminated inter-agent message with a long whitespace run in linear time", () => {
    const line = encodeUnknownJson({
      step_index: 1,
      type: "SYSTEM_MESSAGE",
      content: `<SYSTEM_MESSAGE>\n[Message] sender=root content=hi${" ".repeat(200_000)}x`,
    });
    const entries = transcriptToSubagentEntries(line, { prompt: "launch" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind === "user_message" && entries[0].text.startsWith("hi")).toBe(true);
  });

  it("maps Antigravity child transcript steps into standard thinking, tool, user, assistant, and error entries", () => {
    const transcript = [
      // Step 0 launch envelope is skipped (already projected as the child thread prompt).
      {
        step_index: 0,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: "2026-11-26T01:33:44Z",
        content:
          "The following is a <SYSTEM_MESSAGE>...\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T01:33:44Z sender=root priority=MESSAGE_PRIORITY_HIGH content=Read README.md and fix the typo\n</SYSTEM_MESSAGE>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T01:33:45Z",
        thinking: "Inspect README.md first and check lines.",
        tool_calls: [
          { name: "read_file", args: { Path: '"/project/README.md"' } },
          {
            name: "edit_file",
            args: {
              Path: '"/project/README.md"',
              Target: '"teh"',
              Replacement: '"the"',
            },
          },
          {
            name: "run_command",
            args: {
              CommandLine: '"npm test"',
              Cwd: '"/project"',
              toolSummary: '"Run tests"',
            },
          },
          {
            name: "grep_search",
            args: { Query: '"marker"', SearchPath: '"/project/src"' },
          },
          {
            name: "search_web",
            args: { query: '"antigravity acp"' },
          },
          {
            name: "read_url_content",
            args: { Url: '"https://example.com/docs"' },
          },
        ],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-26T01:33:46Z",
        content:
          "Created At: 2026-11-26T02:33:46+01:00\nCompleted At: 2026-11-26T02:33:47+01:00\n1: teh readme",
      },
      {
        step_index: 3,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-26T01:33:47Z",
        content: "Edited README.md",
      },
      {
        step_index: 4,
        source: "MODEL",
        type: "GENERIC",
        status: "ERROR",
        created_at: "2026-11-26T01:33:48Z",
        error: "Command exited with code 1",
        content:
          "Created At: 2026-11-26T02:33:48+01:00\nEncountered error in step execution: Command exited with code 1",
      },
      {
        step_index: 5,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-26T01:33:49Z",
        content: "src/index.ts:10:marker",
      },
      {
        step_index: 6,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-26T01:33:50Z",
        content: "See https://example.com/acp",
      },
      // Step 7 intentionally omitted for read_url_content to verify live in_progress vs finalized interrupted.
      // Internal harness reminders are skipped; inter-agent [Message] updates become user_message.
      {
        step_index: 8,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        content:
          "The following is a <SYSTEM_MESSAGE>...\n\n<SYSTEM_MESSAGE>\nReminder: work efficiently.\n</SYSTEM_MESSAGE>",
      },
      {
        step_index: 9,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: "2026-11-26T01:33:52Z",
        content:
          "The following is a <SYSTEM_MESSAGE>...\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T01:33:52Z sender=root priority=MESSAGE_PRIORITY_HIGH content=Also check CHANGELOG.md\n</SYSTEM_MESSAGE>",
      },
      { step_index: 10, source: "SYSTEM", type: "CHECKPOINT", status: "DONE" },
      {
        step_index: 11,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T01:33:55Z",
        content: "Fixed the typo in README.md and checked CHANGELOG.md.",
      },
      {
        step_index: 12,
        source: "SYSTEM",
        type: "ERROR_MESSAGE",
        status: "ERROR",
        error: "Transient warning",
      },
    ]
      .map((line) => encodeUnknownJson(line))
      .join("\n");

    const live = transcriptToSubagentEntries(transcript, {
      prompt: "Read README.md and fix the typo",
      finalize: false,
    });
    expect(live.map((entry) => entry.kind)).toEqual([
      "reasoning",
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
      "user_message",
      "assistant_message",
      "error",
    ]);

    const reasoning = live[0];
    expect(reasoning?.kind === "reasoning" && reasoning.text).toBe(
      "Inspect README.md first and check lines.",
    );
    const readTool = live[1];
    expect(readTool?.kind === "tool" && readTool.toolCall).toMatchObject({
      kind: "read",
      status: "completed",
      data: {
        locations: [{ path: "/project/README.md" }],
        rawOutput: "1: teh readme",
      },
    });
    const editTool = live[2];
    expect(editTool?.kind === "tool" && editTool.toolCall).toMatchObject({
      kind: "edit",
      status: "completed",
      data: {
        locations: [{ path: "/project/README.md" }],
        content: [{ type: "diff", path: "/project/README.md", oldText: "teh", newText: "the" }],
      },
    });
    const execTool = live[3];
    expect(execTool?.kind === "tool" && execTool.toolCall).toMatchObject({
      kind: "execute",
      status: "failed",
      command: "npm test",
      title: "Run tests",
      data: { rawOutput: "Command exited with code 1" },
    });
    const grepTool = live[4];
    expect(grepTool?.kind === "tool" && grepTool.toolCall).toMatchObject({
      kind: "search",
      status: "completed",
      data: {
        rawInput: { query: "marker", pattern: "marker", path: "/project/src" },
        locations: [{ path: "/project/src" }],
      },
    });
    const webSearchTool = live[5];
    expect(webSearchTool?.kind === "tool" && webSearchTool.toolCall).toMatchObject({
      kind: "search",
      title: "Web search",
      status: "completed",
    });
    const pendingFetchLive = live[6];
    expect(pendingFetchLive?.kind === "tool" && pendingFetchLive.toolCall.status).toBe(
      "inProgress",
    );
    const followUpUser = live[7];
    expect(followUpUser?.kind === "user_message" && followUpUser.text).toBe(
      "Also check CHANGELOG.md",
    );
    const assistant = live[8];
    expect(assistant?.kind === "assistant_message" && assistant.text).toBe(
      "Fixed the typo in README.md and checked CHANGELOG.md.",
    );

    const finalized = transcriptToSubagentEntries(transcript, {
      prompt: "Read README.md and fix the typo",
      finalize: true,
    });
    const pendingFetchFinal = finalized[6];
    expect(pendingFetchFinal?.kind === "tool" && pendingFetchFinal.projectedStatus).toBe(
      "interrupted",
    );

    const checkpointMidToolTranscript = [
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [{ name: "read_file", args: { Path: encodeUnknownJson("/project/a.ts") } }],
      },
      { step_index: 2, source: "SYSTEM", type: "CHECKPOINT", status: "DONE" },
      {
        step_index: 3,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        content: "export const a = 1;",
      },
    ]
      .map((line) => encodeUnknownJson(line))
      .join("\n");
    const checkpointEntries = transcriptToSubagentEntries(checkpointMidToolTranscript, {
      prompt: "Read a.ts",
    });
    expect(checkpointEntries).toHaveLength(1);
    expect(checkpointEntries[0]?.kind === "tool" && checkpointEntries[0].toolCall).toMatchObject({
      kind: "read",
      status: "completed",
      data: { rawOutput: "export const a = 1;" },
    });
  });

  it.effect(
    "reads detached agy 1.5 and direct childSessionId transcripts via readAntigravitySubagentTranscript",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profile = yield* fs.makeTempDirectoryScoped({ prefix: "goat-agy-transcript-" });
        const write = (segments: ReadonlyArray<string>, body: string) => {
          const file = path.join(profile, "antigravity-acp", "brain", ...segments);
          return fs
            .makeDirectory(path.dirname(file), { recursive: true })
            .pipe(Effect.andThen(fs.writeFileString(file, body)));
        };

        yield* write(
          [ROOT, ".system_generated", "subagents", `${CHILD}.json`],
          encodeUnknownJson({ conversationId: CHILD, subagentDescriptor: { role: "Researcher" } }),
        );
        yield* write(
          [CHILD, ".system_generated", "messages", "launch.json"],
          encodeUnknownJson({
            sender: ROOT,
            content: "Check package.json",
            sourceMetadata: {
              tool: {
                toolCall: {
                  id: "call_sub_1",
                  name: "invoke_subagent",
                  argumentsJson: encodeUnknownJson({
                    Role: "Researcher",
                    Prompt: "Check package.json",
                  }),
                },
              },
            },
          }),
        );
        yield* write(
          [CHILD, ".system_generated", "logs", "transcript.jsonl"],
          [
            {
              step_index: 0,
              type: "SYSTEM_MESSAGE",
              status: "DONE",
              content: "Check package.json",
            },
            {
              step_index: 1,
              type: "PLANNER_RESPONSE",
              status: "DONE",
              thinking: "Reading package.json now.",
              tool_calls: [{ name: "read_file", args: { Path: '"/project/package.json"' } }],
            },
            { step_index: 2, type: "GENERIC", status: "DONE", content: '{"name":"demo"}' },
            {
              step_index: 3,
              type: "PLANNER_RESPONSE",
              status: "DONE",
              content: "Package name is demo.",
            },
          ]
            .map((line) => encodeUnknownJson(line))
            .join("\n") + "\n",
        );

        const detached = yield* readAntigravitySubagentTranscript({
          profileDirectory: profile,
          rootSessionId: ROOT,
          nativeTaskId: "call_sub_1",
          launch: { title: "Researcher", prompt: "Check package.json" },
          siblings: [],
          finalize: false,
        });
        expect(detached.map((entry) => entry.kind)).toEqual([
          "reasoning",
          "tool",
          "assistant_message",
        ]);
        // A lone child's ids and key already name it, so a sibling appearing later renames nothing.
        expect(detached.every((entry) => entry.childKey === CHILD)).toBe(true);
        expect(detached.every((entry) => entry.itemId.startsWith(`${CHILD}:`))).toBe(true);

        // Direct childSessionId fallback works even when no subagents/ inbox record exists (e.g. swarm worker).
        const direct = yield* readAntigravitySubagentTranscript({
          profileDirectory: profile,
          rootSessionId: ROOT,
          nativeTaskId: "call_swarm_unknown",
          childSessionId: CHILD,
          launch: { title: "@worker", prompt: "Check package.json" },
          siblings: [],
          finalize: true,
        });
        expect(direct.map((entry) => entry.kind)).toEqual([
          "reasoning",
          "tool",
          "assistant_message",
        ]);
      }),
  );
});
