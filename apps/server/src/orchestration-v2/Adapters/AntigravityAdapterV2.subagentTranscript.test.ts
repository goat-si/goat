import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";

import { openSessionWithRunningCommand } from "./AntigravityWake.testkit.ts";

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

describe("AntigravityAdapterV2 subagent transcript projection", () => {
  it.effect(
    "projects Antigravity subagent transcript thinking, typed tools, and assistant reply live and keeps them when Idle",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profile = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "goat-antigravity-subagent-live-",
        });
        const records = (conversationId: string, kind: string) =>
          path.join(profile, "antigravity-acp", "brain", conversationId, ".system_generated", kind);
        const writeJson = (directory: string, name: string, value: unknown) =>
          fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.andThen(
                fileSystem.writeFileString(path.join(directory, name), encodeUnknownJson(value)),
              ),
            );
        const writeTranscript = (lines: ReadonlyArray<unknown>) => {
          const directory = records("child-1", "logs");
          return fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.andThen(
                fileSystem.writeFileString(
                  path.join(directory, "transcript.jsonl"),
                  `${lines.map((line) => encodeUnknownJson(line)).join("\n")}\n`,
                ),
              ),
            );
        };

        yield* writeJson(records("mock-session-1", "subagents"), "child-1.json", {
          conversationId: "child-1",
          subagentDescriptor: { role: "Codebase Researcher" },
        });
        yield* writeJson(records("child-1", "messages"), "launch.json", {
          sender: "mock-session-1",
          content: "Read README.md",
          sourceMetadata: {
            tool: { toolCall: { id: "call_research", name: "invoke_subagent" } },
          },
        });
        // While running, the child has written thinking, a completed read_file, an edit_file, and a running command.
        yield* writeTranscript([
          { step_index: 0, type: "SYSTEM_MESSAGE", status: "DONE", content: "Read README.md" },
          {
            step_index: 1,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            thinking: "Checking README.md and applying the fix.",
            tool_calls: [
              { name: "read_file", args: { Path: '"/project/README.md"' } },
              {
                name: "edit_file",
                args: {
                  Path: '"/project/README.md"',
                  Target: '"old"',
                  Replacement: '"new"',
                },
              },
              {
                name: "run_command",
                args: { CommandLine: '"pnpm test"', toolSummary: '"Run tests"' },
              },
            ],
          },
          {
            step_index: 2,
            type: "GENERIC",
            status: "DONE",
            content: "Created At: 2026-11-26T02:00:00+01:00\n1: old line",
          },
          {
            step_index: 3,
            type: "GENERIC",
            status: "DONE",
            content: "Updated README.md",
          },
        ]);

        const { usage, send, startTurn, until, throughPromptSettled } =
          yield* openSessionWithRunningCommand({}, profile);
        yield* startTurn(1, false);
        const promptEvents = yield* throughPromptSettled;

        const childThread = promptEvents.find((event) => event.type === "app_thread.created");
        assert.isDefined(childThread);
        const childThreadId =
          childThread?.type === "app_thread.created" ? childThread.appThread.id : undefined;
        assert.isDefined(childThreadId);

        // Give the live transcript follower a poll tick while the subagent is still running.
        yield* TestClock.adjust("1 second");

        // Now the child completes its command, writes its final assistant reply, and reports back to parent.
        yield* writeTranscript([
          { step_index: 0, type: "SYSTEM_MESSAGE", status: "DONE", content: "Read README.md" },
          {
            step_index: 1,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            thinking: "Checking README.md and applying the fix.",
            tool_calls: [
              { name: "read_file", args: { Path: '"/project/README.md"' } },
              {
                name: "edit_file",
                args: {
                  Path: '"/project/README.md"',
                  Target: '"old"',
                  Replacement: '"new"',
                },
              },
              {
                name: "run_command",
                args: { CommandLine: '"pnpm test"', toolSummary: '"Run tests"' },
              },
            ],
          },
          {
            step_index: 2,
            type: "GENERIC",
            status: "DONE",
            content: "Created At: 2026-11-26T02:00:00+01:00\n1: old line",
          },
          {
            step_index: 3,
            type: "GENERIC",
            status: "DONE",
            content: "Updated README.md",
          },
          {
            step_index: 4,
            type: "GENERIC",
            status: "DONE",
            content: "All tests passed.",
          },
          {
            step_index: 5,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            content: "Updated README.md and verified all tests pass.",
          },
        ]);
        yield* writeJson(records("mock-session-1", "messages"), "report.json", {
          sender: "child-1",
        });
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The researcher finished." },
        });
        yield* send(usage);
        yield* TestClock.adjust("3 seconds");
        const tailEvents = yield* until((event) => event.type === "turn.terminal");
        const allEvents = [...promptEvents, ...tailEvents];

        const childItemsById = new Map<
          string,
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>["turnItem"]
        >();
        for (const event of allEvents) {
          if (event.type === "turn_item.updated" && event.turnItem.threadId === childThreadId) {
            childItemsById.set(String(event.turnItem.id), event.turnItem);
          }
        }
        const childItems = [...childItemsById.values()].toSorted((a, b) => a.ordinal - b.ordinal);
        assert.deepEqual(
          childItems.map((item) => item.type),
          [
            "user_message",
            "reasoning",
            "dynamic_tool",
            "file_change",
            "command_execution",
            "assistant_message",
          ],
        );
        const reasoning = childItems[1];
        assert.equal(
          reasoning?.type === "reasoning" ? reasoning.text : null,
          "Checking README.md and applying the fix.",
        );
        const readItem = childItems[2];
        assert.equal(readItem?.type === "dynamic_tool" ? readItem.toolName : null, "Read");
        assert.equal(readItem?.type === "dynamic_tool" ? readItem.output : null, "1: old line");
        const fileChange = childItems[3];
        assert.equal(
          fileChange?.type === "file_change" ? fileChange.fileName : null,
          "/project/README.md",
        );
        assert.include(
          fileChange?.type === "file_change" ? (fileChange.diffStr ?? "") : "",
          "-old",
        );
        assert.include(
          fileChange?.type === "file_change" ? (fileChange.diffStr ?? "") : "",
          "+new",
        );
        const command = childItems[4];
        assert.equal(command?.type === "command_execution" ? command.input : null, "pnpm test");
        assert.equal(
          command?.type === "command_execution" ? command.output : null,
          "All tests passed.",
        );
        assert.equal(command?.status, "completed");
        const assistant = childItems[5];
        assert.equal(
          assistant?.type === "assistant_message" ? assistant.text : null,
          "Updated README.md and verified all tests pass.",
        );

        const lastSubagent = allEvents.findLast((event) => event.type === "subagent.updated");
        assert.equal(
          lastSubagent?.type === "subagent.updated" ? lastSubagent.subagent.status : null,
          "idle",
        );
        assert.equal(
          lastSubagent?.type === "subagent.updated" ? lastSubagent.subagent.result : null,
          "Updated README.md and verified all tests pass.",
        );
      }).pipe(Effect.provide(layerSession)),
  );

  it.effect(
    "captures a subagent's closing assistant reply written shortly after send_message marks it Idle",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profile = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "goat-antigravity-subagent-trailing-",
        });
        const records = (conversationId: string, kind: string) =>
          path.join(profile, "antigravity-acp", "brain", conversationId, ".system_generated", kind);
        const writeJson = (directory: string, name: string, value: unknown) =>
          fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.andThen(
                fileSystem.writeFileString(path.join(directory, name), encodeUnknownJson(value)),
              ),
            );
        const writeTranscript = (lines: ReadonlyArray<unknown>) => {
          const directory = records("child-1", "logs");
          return fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.andThen(
                fileSystem.writeFileString(
                  path.join(directory, "transcript.jsonl"),
                  `${lines.map((line) => encodeUnknownJson(line)).join("\n")}\n`,
                ),
              ),
            );
        };

        yield* writeJson(records("mock-session-1", "subagents"), "child-1.json", {
          conversationId: "child-1",
          subagentDescriptor: { role: "Rich Format Tester" },
        });
        yield* writeJson(records("child-1", "messages"), "launch.json", {
          sender: "mock-session-1",
          content: "Format a markdown summary",
          sourceMetadata: {
            tool: { toolCall: { id: "call_research", name: "invoke_subagent" } },
          },
        });
        const preReplySteps = [
          {
            step_index: 0,
            type: "SYSTEM_MESSAGE",
            status: "DONE",
            content: "Format a markdown summary",
          },
          {
            step_index: 1,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            tool_calls: [{ name: "send_message", args: { Message: '"Done!"' } }],
          },
          { step_index: 2, type: "GENERIC", status: "DONE", content: "Message sent." },
        ];
        yield* writeTranscript(preReplySteps);
        yield* writeJson(records("mock-session-1", "messages"), "report.json", {
          sender: "child-1",
        });

        const { startTurn, until, throughPromptSettled, session, providerThread } =
          yield* openSessionWithRunningCommand({}, profile);
        assert.isDefined(session.hasPendingBackgroundWorkForThread);
        const runKeepsIngesting =
          session.hasPendingBackgroundWorkForThread?.(providerThread) ?? Effect.succeed(false);
        yield* startTurn(1, false);
        const promptEvents = yield* throughPromptSettled;
        const childThread = promptEvents.find((event) => event.type === "app_thread.created");
        const childThreadId =
          childThread?.type === "app_thread.created" ? childThread.appThread.id : undefined;
        assert.isDefined(childThreadId);

        // Child became Idle as soon as report.json landed, before its closing PLANNER_RESPONSE flushed.
        const idleSubagent = promptEvents.findLast((event) => event.type === "subagent.updated");
        assert.equal(
          idleSubagent?.type === "subagent.updated" ? idleSubagent.subagent.status : null,
          "idle",
        );
        // The run reads this probe once the root ends; it must already hold the drain at Idle.
        assert.isTrue(yield* runKeepsIngesting);

        // Closing reply lands in transcript.jsonl after Idle.
        yield* writeTranscript([
          ...preReplySteps,
          {
            step_index: 3,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            content: "## Summary\n\n| Check | Status |\n| --- | --- |\n| Diff | Passed |",
          },
        ]);
        yield* TestClock.adjust("2 seconds");
        const trailingEvents = yield* until(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.threadId === childThreadId &&
            event.turnItem.type === "assistant_message",
        );
        const assistantItem = trailingEvents.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.threadId === childThreadId &&
            event.turnItem.type === "assistant_message",
        );
        assert.equal(
          assistantItem?.type === "turn_item.updated" &&
            assistantItem.turnItem.type === "assistant_message"
            ? assistantItem.turnItem.text
            : null,
          "## Summary\n\n| Check | Status |\n| --- | --- |\n| Diff | Passed |",
        );
        // The drain ends with a subagent event, so the run re-checks and stops ingesting.
        let pending = true;
        for (let attempt = 0; attempt < 2 && pending; attempt += 1) {
          yield* until((event) => event.type === "subagent.updated");
          pending = yield* runKeepsIngesting;
        }
        assert.isFalse(pending);
      }).pipe(Effect.provide(layerSession)),
  );
});
