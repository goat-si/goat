import { assert, describe, it } from "@effect/vitest";
import {
  goatBotChangeNoteMessage,
  goatBotForgetNoteMessage,
  type ChannelReceptionInput,
  type ChannelReceptionResult,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { NOTES_HEADER, parseChannelBotNoteLines } from "./channelBotNoteLines.ts";
import { appendChannelBotNote, channelBotFilesFor } from "./channelBotNotes.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import { inputIdFor } from "./channelIds.ts";
import {
  botMessages,
  defaultScript,
  goatInput,
  linkSlackUser,
  makeHarness,
  ownerId,
  rpcContext,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const fridays = "I deploy on Fridays.";

/** A harness whose model answers `decide` and records every input it was asked about. */
const harnessFor = (decide: (text: string) => Partial<ChannelReceptionResult> = () => ({})) => {
  const harness = makeHarness();
  const asked: Array<string> = [];
  harness.script.current = (input: ChannelReceptionInput) => {
    if (input.mode !== "input") return defaultScript(input);
    asked.push(input.inputText ?? "");
    const result: ChannelReceptionResult = {
      replyText: "Got it.",
      action: { type: "report_only" },
      ...decide(input.inputText ?? ""),
    };
    return Effect.succeed(result);
  };
  return { asked, layer: harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)) };
};

const notesFiles = Effect.gen(function* () {
  return channelBotFilesFor(yield* Path.Path, (yield* ServerConfig.ServerConfig).stateDir);
});

const writeNotes = (text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* notesFiles;
    yield* fs.makeDirectory(files.dir, { recursive: true });
    yield* fs.writeFileString(files.notes, text);
    return files;
  });

const readNotes = Effect.gen(function* () {
  return yield* (yield* FileSystem.FileSystem).readFileString((yield* notesFiles).notes);
});

const send = (text: string, key: string) =>
  Effect.gen(function* () {
    yield* (yield* ChannelGateway.ChannelGateway).ingest(goatInput(text, key), rpcContext);
    yield* (yield* ChannelRuntime.ChannelRuntime).drain;
  });

const replies = Effect.map(botMessages, (page) =>
  page.messages.map((message) => message.text).join("\n"),
);

const taskCount = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  return (yield* ledger.listTasks({ ownerId, limit: 50 })).tasks.length;
});

const line = (text: string, id: string, replaces?: string) =>
  "- 2026-11-01: " +
  text +
  " (asked in " +
  id +
  ")" +
  (replaces === undefined ? "" : " (replaces: " + JSON.stringify(replaces) + ")");

describe("Memory tab requests to change or forget a note", () => {
  it.effect("Ask to change appends the new note with a replaces marker without the model", () => {
    const { asked, layer } = harnessFor();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER + line(fridays, "earlier") + "\n");
      const message = goatBotChangeNoteMessage(fridays, "I deploy on Mondays.");
      yield* send(message, "tab-change");
      assert.notInclude(asked, message);
      const saved = yield* readNotes;
      assert.include(saved, line(fridays, "earlier") + "\n");
      assert.match(
        saved,
        /I deploy on Mondays\. \(asked in [^)]+\) \(replaces: "I deploy on Fridays\."\)\n$/u,
      );
      assert.include(yield* replies, CHANNEL_COPY.noteChanged);
      assert.strictEqual(yield* taskCount, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("Ask to change replaces a note older than the newest 64 KiB", () => {
    const { layer } = harnessFor();
    return Effect.gen(function* () {
      yield* setupBot;
      const filler = Array.from({ length: 900 }, (_, at) =>
        line("Water the plants on shelf " + at + " before lunch every day.", "fill-" + at),
      );
      yield* writeNotes(NOTES_HEADER + [line(fridays, "earlier"), ...filler].join("\n") + "\n");
      yield* send(goatBotChangeNoteMessage(fridays, "I deploy on Mondays."), "tab-change");
      const lines = parseChannelBotNoteLines(yield* readNotes);
      assert.isDefined(lines.find((note) => note.text === fridays)?.replacedBy);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a change replayed after a restart answers the same and saves one line", () => {
    const { asked, layer } = harnessFor();
    return Effect.gen(function* () {
      yield* setupBot;
      const fs = yield* FileSystem.FileSystem;
      const files = yield* writeNotes(NOTES_HEADER + line(fridays, "earlier") + "\n");
      const message = goatBotChangeNoteMessage(fridays, "I deploy on Mondays.");
      // The first pass saved the line, then the server stopped before the result committed.
      const inputId = inputIdFor({ ...goatInput(message, "tab-change"), ownerId });
      yield* appendChannelBotNote(
        fs,
        files,
        "I deploy on Mondays.",
        "2026-11-02T10:00:00Z",
        inputId,
        fridays,
      );
      const before = yield* readNotes;
      yield* send(message, "tab-change");
      assert.strictEqual(yield* readNotes, before);
      assert.notInclude(asked, message);
      assert.include(yield* replies, CHANNEL_COPY.noteChanged);
    }).pipe(Effect.provide(layer));
  });

  it.effect("Ask to forget removes the note, the notes it replaced and quotes of them", () => {
    const { asked, layer } = harnessFor();
    return Effect.gen(function* () {
      yield* setupBot;
      const mina = "Send the weekly summary to Mina.";
      const hyejin = "Send the weekly summary to Hyejin.";
      const daniel = "Send the weekly summary to Daniel.";
      const korean = line("Reply in Korean.", "korean") + "\r\n";
      yield* writeNotes(
        NOTES_HEADER +
          line(mina, "a") +
          "\n" +
          korean +
          line(hyejin, "b", mina) +
          "\n" +
          line(daniel, "c", hyejin) +
          "\n" +
          line("Weekly sync is on Monday.", "g", mina) +
          "\n",
      );
      const message = goatBotForgetNoteMessage(daniel);
      yield* send(message, "tab-forget");
      assert.notInclude(asked, message);
      assert.strictEqual(
        yield* readNotes,
        NOTES_HEADER + korean + line("Weekly sync is on Monday.", "g") + "\n",
      );
      assert.include(yield* replies, CHANNEL_COPY.noteForgotten);
      assert.strictEqual(yield* taskCount, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("Ask to forget a note that is not there changes nothing, without the model", () => {
    const { asked, layer } = harnessFor();
    return Effect.gen(function* () {
      yield* setupBot;
      const text = NOTES_HEADER + line(fridays, "earlier") + "\n";
      yield* writeNotes(text);
      const message = goatBotForgetNoteMessage("I deploy on Sundays.");
      yield* send(message, "tab-forget");
      assert.strictEqual(yield* readNotes, text);
      assert.notInclude(asked, message);
      assert.include(yield* replies, CHANNEL_COPY.noteNotFound);
      assert.strictEqual(yield* taskCount, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a Slack person whose link was removed cannot forget a note", () => {
    const { layer } = harnessFor();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const text = NOTES_HEADER + line(fridays, "earlier") + "\n";
      yield* writeNotes(text);
      yield* (yield* ChannelLedger.ChannelLedger).unlinkIdentity({
        connectionId: "slack-1",
        externalActorId: "U1",
      });
      yield* (yield* ChannelGateway.ChannelGateway).ingest(
        slackInput(goatBotForgetNoteMessage(fridays), "slack-forget"),
        slackContext,
      );
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      assert.strictEqual(yield* readNotes, text);
      assert.strictEqual(yield* taskCount, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a forget waits while a task that may edit the notes is still open", () => {
    const { layer } = harnessFor((text) =>
      text.startsWith("Please tidy")
        ? {
            replyText: "Tidying your notes now.",
            action: {
              type: "run_turn",
              title: "Tidy notes",
              instruction: "Tidy the notes file.",
              notesChangeRequested: "Please tidy my notes",
            },
          }
        : {},
    );
    return Effect.gen(function* () {
      yield* setupBot;
      const text = NOTES_HEADER + line(fridays, "earlier") + "\n";
      yield* writeNotes(text);
      yield* send("Please tidy my notes", "tidy");
      yield* send(goatBotForgetNoteMessage(fridays), "tab-forget");
      assert.strictEqual(yield* readNotes, text);
      assert.include(yield* replies, CHANNEL_COPY.noteEditBusy);
    }).pipe(Effect.provide(layer));
  });
});

describe("corrections the model reports", () => {
  it.effect("a correction quoted with a closing period is still saved", () => {
    const { layer } = harnessFor(() => ({
      remember: "I deploy on Mondays.",
      rememberQuote: "Actually I deploy on Mondays.",
      replacesNote: fridays,
    }));
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER + line(fridays, "earlier") + "\n");
      yield* send("Actually I deploy on Mondays", "correct");
      assert.include(yield* readNotes, '(replaces: "I deploy on Fridays.")');
    }).pipe(Effect.provide(layer));
  });

  it.effect("a note the message never asked for is reported as not saved", () => {
    const { layer } = harnessFor(() => ({
      replyText: "Got it, I'll remember that.",
      remember: "I deploy on Mondays.",
      rememberQuote: "remember I deploy on Mondays",
    }));
    return Effect.gen(function* () {
      yield* setupBot;
      const text = NOTES_HEADER + line(fridays, "earlier") + "\n";
      yield* writeNotes(text);
      yield* send("Mondays work better for me this week", "drop");
      assert.strictEqual(yield* readNotes, text);
      assert.include(yield* replies, "Got it, I'll remember that. " + CHANNEL_COPY.noteNotSaved);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a dropped note is reported even when the model asks a question", () => {
    const { layer } = harnessFor(() => ({
      replyText: "Which day should I use?",
      action: { type: "clarify", question: "Which day should I use?", options: [] },
      remember: "I deploy on Mondays.",
      rememberQuote: "remember I deploy on Mondays",
    }));
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER + line(fridays, "earlier") + "\n");
      yield* send("Mondays work better for me this week", "drop");
      assert.include(yield* replies, CHANNEL_COPY.noteNotSaved);
    }).pipe(Effect.provide(layer));
  });
});
