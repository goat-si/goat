import { assert, describe, it } from "@effect/vitest";
import {
  ChannelConversationId,
  ChannelInputId,
  ChannelQuestionId,
  ChannelTaskId,
  type ChannelMessageMeta,
  type ChannelTimelineRecord,
  CommandId,
  MessageId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as AttachmentLifecycle from "../assets/AttachmentLifecycle.testkit.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import { ChannelBotTimeline } from "./ChannelBotTimeline.ts";
import * as ChannelBotRegistry from "./ChannelBotRegistry.ts";
import { botThreadId, makeHarness, owner, setupBot } from "./testkit/ChannelHarness.ts";

const TASK = ChannelTaskId.make("task-preview");

/** The person writes in the bot's main chat, through the path the GOAT clients use. */
const send = (text: string, key: string) =>
  ThreadMessageIntake.dispatchCommand(
    {
      type: "message.dispatch",
      commandId: CommandId.make(key),
      threadId: botThreadId,
      messageId: MessageId.make(key + "-message"),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    },
    owner,
  ).pipe(Effect.provide(AttachmentLifecycle.layerFiles));

/** The conversation and input the gateway recorded for the person's message with this text. */
const sentInput = (text: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly conversation_id: string; readonly input_id: string }>`
      SELECT json_extract(payload_json, '$.channel.conversationId') AS conversation_id,
        json_extract(payload_json, '$.channel.inputId') AS input_id
      FROM orchestration_v2_projection_messages
      WHERE thread_id = ${botThreadId} AND role = 'user'
        AND json_extract(payload_json, '$.text') = ${text}`;
    assert.isDefined(row);
    return {
      conversationId: ChannelConversationId.make(row!.conversation_id),
      inputId: ChannelInputId.make(row!.input_id),
    };
  });

type Entry = Extract<ChannelTimelineRecord["entry"], { readonly type: "message" }>;

/** One message written to the bot thread as the GOAT transport writes it, a second after the last. */
const record = (
  key: string,
  entry: Omit<Entry, "type" | "meta"> & {
    readonly meta: Omit<ChannelMessageMeta, "originKind" | "conversationId">;
  },
  conversationId: ChannelConversationId,
) =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 second");
    yield* (yield* ChannelBotTimeline).record({
      threadId: botThreadId,
      record: {
        recordKey: key,
        entry: {
          type: "message",
          ...entry,
          meta: { originKind: "goat", conversationId, ...entry.meta },
        },
      },
      revision: "send",
    });
  });

const latestOf = ChannelBotRegistry.ChannelBotRegistry.pipe(
  Effect.flatMap((registry) => registry.status(owner)),
  Effect.map((status) => status.latest),
);

describe("a bot's status previews the newest message its chat shows", () => {
  it.effect("a task's own messages stay out of the preview, as they stay out of the chat", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* TestClock.adjust("1 second");
      yield* send("is main green?", "main-request");
      const { conversationId, inputId } = yield* sentInput("is main green?");
      const said = () => latestOf.pipe(Effect.map((latest) => [latest?.author, latest?.text]));

      // Progress a task narrates, and its reply to a message sent in the task's own view.
      yield* record(
        "progress",
        { role: "assistant", text: "Running the tests.", meta: { kind: "status", taskId: TASK } },
        conversationId,
      );
      yield* record(
        "input:task-view",
        {
          role: "user",
          text: "use the staging config",
          meta: { kind: "inbound", inputId: ChannelInputId.make("task-view"), taskId: TASK },
        },
        conversationId,
      );
      yield* record(
        "task-view-reply",
        {
          role: "assistant",
          text: "Switching to staging.",
          meta: {
            kind: "receipt",
            taskId: TASK,
            inReplyToInputId: ChannelInputId.make("task-view"),
          },
        },
        conversationId,
      );
      assert.deepStrictEqual(yield* said(), ["person", "is main green?"]);

      // The task's answer to the request made in the main chat shows there.
      yield* record(
        "main-reply",
        {
          role: "assistant",
          text: "Checking main now.",
          meta: { kind: "receipt", taskId: TASK, inReplyToInputId: inputId },
        },
        conversationId,
      );
      assert.deepStrictEqual(yield* said(), ["bot", "Checking main now."]);

      // A task's question, the person's pick on its card, and how the work ended all show.
      yield* record(
        "question",
        {
          role: "assistant",
          text: "Which branch?",
          meta: {
            kind: "question",
            taskId: TASK,
            options: ["main", "dev"],
            questionId: ChannelQuestionId.make("q1"),
          },
        },
        conversationId,
      );
      assert.deepStrictEqual(yield* said(), ["bot", "Which branch?"]);
      yield* record(
        "input:pick",
        {
          role: "user",
          text: "dev",
          meta: {
            kind: "inbound",
            inputId: ChannelInputId.make("pick"),
            taskId: TASK,
            answersQuestionId: ChannelQuestionId.make("q1"),
          },
        },
        conversationId,
      );
      assert.deepStrictEqual(yield* said(), ["person", "dev"]);
      yield* record(
        "result",
        { role: "assistant", text: "Main is green.", meta: { kind: "result", taskId: TASK } },
        conversationId,
      );
      assert.deepStrictEqual(yield* said(), ["bot", "Main is green."]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a message of only files previews as their names", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* TestClock.adjust("1 second");
      yield* send("hello", "hello");
      const { conversationId } = yield* sentInput("hello");
      yield* record(
        "input:photos",
        {
          role: "user",
          text: "",
          attachments: [
            { type: "image", id: "shot-1", name: "build.png", mimeType: "image/png", sizeBytes: 10 },
            { type: "file", id: "log-1", name: "ci.log", mimeType: "text/plain", sizeBytes: 10 },
          ],
          meta: { kind: "inbound", inputId: ChannelInputId.make("photos") },
        },
        conversationId,
      );
      const latest = yield* latestOf;
      assert.strictEqual(latest?.author, "person");
      assert.strictEqual(latest?.text, "build.png, ci.log");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("Markdown goes before the line is cut, so a long reply never ends in markup", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* TestClock.adjust("1 second");
      yield* send("status?", "status");
      const { conversationId } = yield* sentInput("status?");
      const words = Array.from({ length: 60 }, (_, index) => "word" + index).join(" ");
      yield* record(
        "long-reply",
        {
          role: "assistant",
          text: "**Main is green.** See [the run](https://example.com/" + "x".repeat(300) + ") " + words,
          meta: { kind: "inbound", inReplyToInputId: ChannelInputId.make("status") },
        },
        conversationId,
      );
      const text = (yield* latestOf)?.text ?? "";
      const plain = ("Main is green. See the run " + words).slice(0, 200).trimEnd();
      assert.strictEqual(text, plain);
    }).pipe(Effect.provide(harness.layer));
  });
});

