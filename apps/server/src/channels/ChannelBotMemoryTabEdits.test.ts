import { assert, describe, it } from "@effect/vitest";
import {
  goatBotChangeNoteMessage,
  goatBotForgetNoteMessage,
  type ChannelTaskId,
  type ChannelReceptionInput,
  type ChannelReceptionResult,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { NOTES_HEADER, parseChannelBotNoteLines } from "./channelBotNoteLines.ts";
import { appendChannelBotNote, channelBotFilesFor } from "./channelBotNotes.ts";
import { CHANNEL_COPY, noteKeptNotice, notesAlikeAnswer } from "./channelCopy.ts";
import { inputIdFor, taskIdFor } from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { makeSessionHarness } from "./testkit/ChannelSessionHarness.ts";
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
const harnessFor = (
  decide: (text: string) => Partial<ChannelReceptionResult> = () => ({}),
  options: Parameters<typeof makeHarness>[0] = {},
) => {
  const harness = makeHarness(options);
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
  return {
    asked,
    harness,
    layer: harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  };
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

  it.effect("Ask to forget removes the note and the notes it replaced, and nothing else", () => {
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
        // The last note's marker bound nothing (Mina was already replaced), so it stays as it was.
        NOTES_HEADER + korean + line("Weekly sync is on Monday.", "g", mina) + "\n",
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

  it.effect(
    "Ask to forget a correction keeps a newer note that reads like the one it replaced",
    () => {
      const { layer } = harnessFor();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* writeNotes(
          NOTES_HEADER +
            line("Use pnpm", "a") +
            "\n" +
            line("Use npm", "b", "Use pnpm") +
            "\n" +
            line("Use pnpm", "c") +
            "\n",
        );
        yield* send(goatBotForgetNoteMessage("Use npm"), "tab-forget");
        assert.strictEqual(yield* readNotes, NOTES_HEADER + line("Use pnpm", "c") + "\n");
        assert.include(yield* replies, CHANNEL_COPY.noteForgotten);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "Ask to forget the end of a correction chain removes the chain and nothing else",
    () => {
      const { layer } = harnessFor();
      return Effect.gen(function* () {
        yield* setupBot;
        const korean = line("Reply in Korean.", "k") + "\n";
        // Saved after the chain with the words of its middle note, so it is a note of its own.
        const tuesday = line("Release on Tuesday.", "d") + "\n";
        yield* writeNotes(
          NOTES_HEADER +
            line("Release on Monday.", "a") +
            "\n" +
            korean +
            line("Release on Tuesday.", "b", "Release on Monday.") +
            "\n" +
            line("Release on Wednesday.", "c", "Release on Tuesday.") +
            "\n" +
            tuesday,
        );
        yield* send(goatBotForgetNoteMessage("Release on Wednesday."), "tab-forget");
        assert.strictEqual(yield* readNotes, NOTES_HEADER + korean + tuesday);
        assert.include(yield* replies, CHANNEL_COPY.noteForgotten);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "Ask to forget refuses when removing the note would change what another replaces",
    () => {
      const { layer } = harnessFor();
      return Effect.gen(function* () {
        yield* setupBot;
        // A hand edit put a note above the header. Without that note the header starts the file
        // again, so its wording stops being a note and the correction below would replace nothing.
        const headerWords = NOTES_HEADER.split("\n")[2] ?? "";
        const text =
          line(fridays, "a") +
          "\n" +
          NOTES_HEADER +
          line("Keep notes short.", "c", headerWords) +
          "\n";
        yield* writeNotes(text);
        yield* send(goatBotForgetNoteMessage(fridays), "tab-forget");
        assert.strictEqual(yield* readNotes, text);
        assert.include(yield* replies, CHANNEL_COPY.noteForgetWouldRebind);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "Ask to forget leaves every other line as it was, an unmatched correction naming it too",
    () => {
      const { layer } = harnessFor();
      return Effect.gen(function* () {
        yield* setupBot;
        // The correction came first, so it replaces nothing; the later note is its own.
        const unmatched = line("Use vp", "z", "Use pnpm") + "\n";
        yield* writeNotes(NOTES_HEADER + unmatched + line("Use pnpm", "x") + "\n");
        yield* send(goatBotForgetNoteMessage("Use pnpm"), "tab-forget");
        assert.strictEqual(yield* readNotes, NOTES_HEADER + unmatched);
        assert.include(yield* replies, CHANNEL_COPY.noteForgotten);
      }).pipe(Effect.provide(layer));
    },
  );

  // Two current notes whose words differ only in spacing count as the same words.
  const alike = () =>
    NOTES_HEADER +
    line("Use pnpm", "a") +
    "\n" +
    line("Reply in Korean.", "k") +
    "\n" +
    "- 2026-11-02: Use  pnpm\n";

  it.effect("Ask to forget words two current notes share changes nothing and says so", () => {
    const { asked, layer } = harnessFor();
    return Effect.gen(function* () {
      yield* setupBot;
      const text = alike();
      yield* writeNotes(text);
      const message = goatBotForgetNoteMessage("Use pnpm");
      yield* send(message, "tab-forget");
      assert.strictEqual(yield* readNotes, text);
      assert.notInclude(asked, message);
      assert.include(yield* replies, notesAlikeAnswer("Use pnpm", 2));
      assert.strictEqual(yield* taskCount, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("Ask to change words two current notes share changes nothing and says so", () => {
    const { asked, layer } = harnessFor();
    return Effect.gen(function* () {
      yield* setupBot;
      const text = alike();
      yield* writeNotes(text);
      const message = goatBotChangeNoteMessage("Use  pnpm", "Use vp");
      yield* send(message, "tab-change");
      assert.strictEqual(yield* readNotes, text);
      assert.notInclude(asked, message);
      assert.include(yield* replies, notesAlikeAnswer("Use pnpm", 2));
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "a note whose same words were replaced earlier is the one current note to change",
    () => {
      const { layer } = harnessFor();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* writeNotes(
          NOTES_HEADER +
            line("Use pnpm", "a") +
            "\n" +
            line("Use npm", "b", "Use pnpm") +
            "\n" +
            line("Use pnpm", "c") +
            "\n",
        );
        yield* send(goatBotChangeNoteMessage("Use  pnpm", "Use vp"), "tab-change");
        assert.include(yield* replies, CHANNEL_COPY.noteChanged);
        const current = parseChannelBotNoteLines(yield* readNotes)
          .filter((note) => note.replacedBy === undefined)
          .map((note) => note.text);
        assert.deepStrictEqual(current, ["Use npm", "Use vp"]);
      }).pipe(Effect.provide(layer));
    },
  );

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

// The default routing hands most messages to the bot's session; the tab's sentences stay here.
describe("Memory tab requests with the default session routing", () => {
  const sessionHarness = (decide?: (text: string) => Partial<ChannelReceptionResult>) =>
    harnessFor(decide, { botWorkspace: true });

  const routing = (value: "session" | "reception") =>
    Effect.flatMap(ServerSettings.ServerSettingsService, (settings) =>
      settings.updateSettings({ goatBotSessionRouting: value }),
    );

  /** A request the session takes as its own task; its first answer frees the conversation. */
  const runningTask = (harness: ReturnType<typeof makeSessionHarness>) =>
    Effect.gen(function* () {
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const input = yield* (yield* ChannelGateway.ChannelGateway).ingest(
        goatInput("Inspect disks", "work"),
        rpcContext,
      );
      yield* runtime.drain;
      const task = (yield* ledger.getTask(taskIdFor(input.inputId, 0)))!;
      harness.assistant(task.task, "Working.");
      yield* runtime.drain;
      return (yield* ledger.getTask(task.task.taskId))!;
    });

  const threadHarness = () => {
    const harness = makeSessionHarness();
    return {
      harness,
      layer: harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    };
  };

  const inThread = (text: string, key: string, taskId: ChannelTaskId) =>
    Effect.gen(function* () {
      const input = yield* (yield* ChannelGateway.ChannelGateway).ingest(
        { ...goatInput(text, key), taskId },
        rpcContext,
      );
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      return input.inputId;
    });

  const repliesTo = (inputId: string) =>
    Effect.map(botMessages, (page) =>
      page.messages.filter((message) => message.channel?.inReplyToInputId === inputId),
    );

  it.effect("Ask to forget is answered here, without a session turn", () => {
    const { asked, harness, layer } = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER + line(fridays, "earlier") + "\n");
      const message = goatBotForgetNoteMessage(fridays);
      yield* send(message, "tab-forget");
      assert.strictEqual(yield* readNotes, NOTES_HEADER);
      assert.include(yield* replies, CHANNEL_COPY.noteForgotten);
      assert.notInclude(asked, message);
      assert.lengthOf(harness.world.launches, 0);
      assert.strictEqual(yield* taskCount, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("Ask to change appends with a replaces marker, without a session turn", () => {
    const { asked, harness, layer } = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER + line(fridays, "earlier") + "\n");
      const message = goatBotChangeNoteMessage(fridays, "I deploy on Mondays.");
      yield* send(message, "tab-change");
      const notes = parseChannelBotNoteLines(yield* readNotes);
      assert.strictEqual(notes.at(-1)?.text, "I deploy on Mondays.");
      assert.isDefined(notes.find((note) => note.text === fridays)?.replacedBy);
      assert.include(yield* replies, CHANNEL_COPY.noteChanged);
      assert.notInclude(asked, message);
      assert.lengthOf(harness.world.launches, 0);
      assert.strictEqual(yield* taskCount, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a change replayed after a restart answers the same and saves one line", () => {
    const { harness, layer } = sessionHarness();
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
      assert.include(yield* replies, CHANNEL_COPY.noteChanged);
      assert.lengthOf(harness.world.launches, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a Slack person whose link was removed is refused, without a session turn", () => {
    const { harness, layer } = sessionHarness();
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
      assert.lengthOf(harness.world.launches, 0);
      assert.strictEqual(yield* taskCount, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("Ask to forget in a finished task's thread is answered here", () => {
    const { harness, layer } = threadHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* writeNotes(NOTES_HEADER + line(fridays, "earlier") + "\n");
      const work = yield* runningTask(harness);
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* commitTransition(
        ledger,
        work,
        { type: "task.completed", payload: { generation: work.task.generation, summary: "Done" } },
        { owner: (yield* ChannelRuntime.ChannelRuntime).ownerToken },
      );
      const launches = harness.world.launches.length;
      const inputId = yield* inThread(
        goatBotForgetNoteMessage(fridays),
        "thread-forget",
        work.task.taskId,
      );
      assert.strictEqual(yield* readNotes, NOTES_HEADER);
      assert.deepStrictEqual(
        (yield* repliesTo(inputId)).map((message) => message.text),
        [CHANNEL_COPY.noteForgotten],
      );
      assert.lengthOf(harness.world.launches, launches);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each(["session", "reception"] as const)(
    "Ask to forget in a running task's thread goes to that task, as before (%s)",
    (setting) => {
      const { harness, layer } = threadHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const text = NOTES_HEADER + line(fridays, "earlier") + "\n";
        yield* writeNotes(text);
        const work = yield* runningTask(harness);
        yield* routing(setting);
        const launches = harness.world.launches.length;
        const tasks = yield* taskCount;
        const inputId = yield* inThread(
          goatBotForgetNoteMessage(fridays),
          "thread-forget",
          work.task.taskId,
        );
        assert.strictEqual(yield* readNotes, text);
        assert.deepStrictEqual(
          (yield* repliesTo(inputId)).map((message) => message.text),
          ["I'll send that to the task."],
        );
        const forwarded = yield* (yield* SqlClient.SqlClient)<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM channel_task_events WHERE task_id = ${work.task.taskId} AND type = 'task.followup.received'`;
        assert.strictEqual(forwarded[0]?.count, 1);
        assert.strictEqual(yield* taskCount, tasks);
        assert.lengthOf(harness.world.launches, launches);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a forget waits while a tidy task reception started is still open", () => {
    const { harness, layer } = sessionHarness((text) =>
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
      yield* routing("reception");
      yield* send("Please tidy my notes", "tidy");
      yield* routing("session");
      const launches = harness.world.launches.length;
      yield* send(goatBotForgetNoteMessage(fridays), "tab-forget");
      assert.strictEqual(yield* readNotes, text);
      assert.include(yield* replies, CHANNEL_COPY.noteEditBusy);
      assert.lengthOf(harness.world.launches, launches);
    }).pipe(Effect.provide(layer));
  });

  const rememberText = "remember that the hotfix branch is hotfix-7";
  const tidyTaskId = taskIdFor(
    inputIdFor({ ...goatInput("Please tidy my notes", "tidy"), ownerId }),
    0,
  );

  const tidyGrant = {
    replyText: "Tidying your notes now.",
    action: {
      type: "run_turn" as const,
      title: "Tidy notes",
      instruction: "Tidy the notes file.",
      notesChangeRequested: "Please tidy my notes",
    },
  };

  const remembered = (
    variant: "remember" | "run_turn" | "follow_up",
  ): Partial<ChannelReceptionResult> => {
    const note = {
      replyText: "I'll remember that.",
      remember: "The hotfix branch is hotfix-7.",
      rememberQuote: rememberText,
    };
    if (variant === "run_turn") {
      return {
        ...note,
        action: { type: "run_turn", title: "Remember the branch", instruction: rememberText },
      };
    }
    if (variant === "follow_up")
      return { ...note, action: { type: "follow_up", taskId: tidyTaskId } };
    return note;
  };

  it.effect.each(["remember", "run_turn", "follow_up"] as const)(
    "a remember during an open tidy grant is refused at once under session routing (%s)",
    (variant) => {
      const { harness, layer } = sessionHarness((text) =>
        text.startsWith("Please tidy")
          ? tidyGrant
          : text === rememberText
            ? remembered(variant)
            : {},
      );
      return Effect.gen(function* () {
        yield* setupBot;
        const text = NOTES_HEADER + line(fridays, "earlier") + "\n";
        yield* writeNotes(text);
        yield* routing("reception");
        yield* send("Please tidy my notes", "tidy");
        yield* routing("session");
        const tidy = yield* (yield* ChannelLedger.ChannelLedger).getTask(tidyTaskId);
        assert.strictEqual(tidy?.task.status, "running");
        assert.isDefined(tidy?.task.notesChangeRequested);
        const launches = harness.world.launches.length;
        const tasks = yield* taskCount;
        const input = yield* (yield* ChannelGateway.ChannelGateway).ingest(
          goatInput(rememberText, "remember-" + variant),
          rpcContext,
        );
        yield* (yield* ChannelRuntime.ChannelRuntime).drain;
        assert.deepStrictEqual(
          (yield* repliesTo(input.inputId)).map((message) => message.text),
          [CHANNEL_COPY.noteEditBusy],
        );
        assert.strictEqual(yield* readNotes, text);
        assert.strictEqual(yield* taskCount, tasks);
        assert.lengthOf(harness.world.launches, launches);
        const forwarded = yield* (yield* SqlClient.SqlClient)<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM channel_task_events WHERE type = 'task.followup.received'`;
        assert.strictEqual(forwarded[0]?.count, 0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a remember with no notes grant still goes to the session", () => {
    const { asked, harness, layer } = sessionHarness((text) =>
      text === rememberText ? remembered("remember") : {},
    );
    return Effect.gen(function* () {
      yield* setupBot;
      const text = NOTES_HEADER + line(fridays, "earlier") + "\n";
      yield* writeNotes(text);
      yield* routing("session");
      yield* send(rememberText, "remember-session");
      assert.notInclude(asked, rememberText);
      assert.strictEqual(yield* readNotes, text);
      assert.strictEqual(yield* taskCount, 1);
      assert.lengthOf(harness.world.launches, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "a tidy that removes a note whose forget it was refused puts it back and says so",
    () => {
      const { harness, layer } = sessionHarness((text) =>
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
        const kept = line(fridays, "earlier");
        const files = yield* writeNotes(NOTES_HEADER + kept + "\n");
        yield* routing("reception");
        yield* send("Please tidy my notes", "tidy");
        yield* send(goatBotForgetNoteMessage(fridays), "tab-forget");
        assert.include(yield* replies, CHANNEL_COPY.noteEditBusy);
        const ledger = yield* ChannelLedger.ChannelLedger;
        const tidy = (yield* ledger.listTasks({ ownerId, limit: 50 })).tasks.find(
          (task) => task.notesChangeRequested !== undefined,
        )!;
        // The tidy turn carries out the refused forget by hand, then finishes.
        yield* (yield* FileSystem.FileSystem).writeFileString(files.notes, NOTES_HEADER);
        const worker = (yield* ledger.getTask(tidy.taskId))!.task.worker!;
        harness.world.setStatus(
          worker.threadId,
          1,
          "completed",
          "Tidied, and forgot the Fridays note.",
        );
        yield* (yield* ChannelRuntime.ChannelRuntime).drain;
        assert.strictEqual((yield* ledger.getTask(tidy.taskId))!.task.status, "completed");
        assert.strictEqual(yield* readNotes, NOTES_HEADER + kept + "\n");
        assert.include(yield* replies, noteKeptNotice(fridays));
      }).pipe(Effect.provide(layer));
    },
  );
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

  it.effect(
    "a notes change the person never worded that way gets no permission and says so",
    () => {
      const { layer } = harnessFor(() => ({
        replyText: "On it.",
        action: {
          type: "create_task",
          title: "Forget a note",
          instruction: "Remove the requested note.",
          notesChangeRequested: "forget the English note",
        },
      }));
      return Effect.gen(function* () {
        yield* setupBot;
        yield* send("Please forget the Korean note", "unworded");
        const ledger = yield* ChannelLedger.ChannelLedger;
        const tasks = (yield* ledger.listTasks({ ownerId, limit: 10 })).tasks;
        assert.isTrue(tasks.every((task) => task.notesChangeRequested === undefined));
        assert.include(yield* replies, "On it. " + CHANNEL_COPY.noteNotSaved);
      }).pipe(Effect.provide(layer));
    },
  );
});
