// @effect-diagnostics-next-line nodeBuiltinImport:off -- mkfifo has no Effect API.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  goatBotChangeNoteMessage,
  goatBotForgetNoteMessage,
  type ChannelRequester,
  type ChannelReceptionResult,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type * as ChannelLedger from "./ChannelLedger.ts";
import { NOTES_HEADER } from "./channelBotNoteLines.ts";
import { appendChannelBotNote, channelBotFilesFor } from "./channelBotNotes.ts";
import { makeChannelBotNoteWriter, type NoteWriterHooks } from "./channelBotNoteTabEdits.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import { inputIdFor } from "./channelIds.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelBotEvents from "./ChannelBotEvents.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
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

// A note line carries the day where GOAT runs; dates here are UTC unless a case sets its own zone.
const services = Layer.merge(NodeServices.layer, DateTime.layerCurrentZoneOffset(0));
const seoulServices = Layer.merge(NodeServices.layer, DateTime.layerCurrentZoneNamed("Asia/Seoul"));

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const person = (overrides: Partial<ChannelRequester> = {}): ChannelRequester => ({
  ownerId: "owner",
  principalId: "alice",
  displayName: "Alice",
  originKind: "goat",
  runtimeModeCeiling: "auto-accept-edits",
  grantedScopes: ["orchestration:operate"],
  ...overrides,
});

const noOpenTasks: Pick<ChannelLedger.ChannelLedger["Service"], "listTasksByStatus"> = {
  listTasksByStatus: () => Effect.succeed([]),
};

const line = (text: string, id: string, replaces?: string) =>
  "- 2026-11-01: " +
  text +
  " (asked in " +
  id +
  ")" +
  (replaces === undefined ? "" : " (replaces: " + JSON.stringify(replaces) + ")");

const fridays = "I deploy on Fridays.";

/** A notes file with `text` and a writer over it. */
const setup = (text: string, hooks: NoteWriterHooks = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = channelBotFilesFor(yield* Path.Path, yield* fs.makeTempDirectoryScoped());
    yield* fs.makeDirectory(files.dir, { recursive: true });
    if (text !== "") yield* fs.writeFileString(files.notes, text);
    const writer = yield* makeChannelBotNoteWriter(fs, files, noOpenTasks, hooks);
    const edit = (
      message: string,
      who: ChannelRequester | null = person(),
      readAt = "2026-11-07T10:00:00Z",
    ) =>
      Effect.map(
        writer.tabEdit(
          { intent: "message", text: message },
          "input-1",
          readAt,
          Effect.succeed(who ?? undefined),
        ),
        (answer) => answer?.text,
      );
    const read = fs.readFileString(files.notes);
    return { fs, files, edit, read };
  });

describe("Memory tab note edits", () => {
  it.effect("leave every other message to reception", () =>
    Effect.gen(function* () {
      const { edit } = yield* setup(NOTES_HEADER + line(fridays, "a") + "\n");
      assert.isUndefined(yield* edit("Please forget the Fridays note"));
      assert.isUndefined(yield* edit(goatBotForgetNoteMessage(fridays) + " and the rest"));
      assert.isUndefined(yield* edit('Please change this note: "I deploy on Fridays."'));
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect("refuse agents, people without a link, and routines change nothing", () =>
    Effect.gen(function* () {
      const text = NOTES_HEADER + line(fridays, "a") + "\n";
      const { edit, read, files, fs } = yield* setup(text);
      const message = goatBotForgetNoteMessage(fridays);
      assert.strictEqual(
        yield* edit(message, person({ originKind: "mcp" })),
        CHANNEL_COPY.noteEditNotAllowed,
      );
      assert.strictEqual(
        yield* edit(message, person({ principalId: "unlinked:slack-1:U9" })),
        CHANNEL_COPY.noteEditNotAllowed,
      );
      assert.strictEqual(yield* edit(message, null), CHANNEL_COPY.noteEditNotAllowed);
      const writer = yield* makeChannelBotNoteWriter(fs, files, noOpenTasks);
      assert.isUndefined(
        yield* writer.tabEdit(
          { intent: "message", text: message },
          "input-1",
          "2026-11-07",
          undefined,
        ),
      );
      assert.strictEqual(yield* read, text);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect(
    "a change keeps the new text on one line and appends after a line without a newline",
    () =>
      Effect.gen(function* () {
        const { edit, read } = yield* setup(NOTES_HEADER + line(fridays, "a"));
        const answer = yield* edit(goatBotChangeNoteMessage(fridays, "I deploy\non Mondays."));
        assert.strictEqual(answer, CHANNEL_COPY.noteChanged);
        assert.strictEqual(
          yield* read,
          NOTES_HEADER +
            line(fridays, "a") +
            "\n- 2026-11-07: I deploy on Mondays. (asked in input-1)" +
            ' (replaces: "I deploy on Fridays.")\n',
        );
      }).pipe(Effect.scoped, Effect.provide(services)),
  );

  // 17:10 UTC is already Nov 8 in Seoul, where GOAT runs.
  it.effect("a change made after midnight where GOAT runs carries that day, not UTC's", () =>
    Effect.gen(function* () {
      const { edit, read } = yield* setup(NOTES_HEADER + line(fridays, "a") + "\n");
      yield* edit(
        goatBotChangeNoteMessage(fridays, "I deploy on Mondays."),
        person(),
        "2026-11-07T17:10:00Z",
      );
      assert.include(yield* read, "\n- 2026-11-08: I deploy on Mondays. (asked in input-1)");
    }).pipe(Effect.scoped, Effect.provide(seoulServices)),
  );

  it.effect("notes with quotes are matched exactly, and a longer message goes to reception", () =>
    Effect.gen(function* () {
      const first = 'Say "hi';
      const second = 'Say "hi" to: "Mina';
      const text = NOTES_HEADER + line(first, "a") + "\n" + line(second, "b") + "\n";
      const { edit, read } = yield* setup(text);
      assert.isUndefined(yield* edit('Please forget this note: "x" and remember "y"'));
      assert.isUndefined(yield* edit(goatBotChangeNoteMessage(second, "Bob") + ' and "z"'));
      assert.strictEqual(yield* read, text);
      assert.strictEqual(
        yield* edit(goatBotChangeNoteMessage(second, "Bob")),
        CHANNEL_COPY.noteChanged,
      );
      const saved = yield* read;
      assert.isTrue(saved.endsWith(" (replaces: " + JSON.stringify(second) + ")\n"));
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect("a forget refuses while a task that may edit the notes is open", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = channelBotFilesFor(yield* Path.Path, yield* fs.makeTempDirectoryScoped());
      yield* fs.makeDirectory(files.dir, { recursive: true });
      const text = NOTES_HEADER + line(fridays, "a") + "\n";
      yield* fs.writeFileString(files.notes, text);
      const busy: Pick<ChannelLedger.ChannelLedger["Service"], "listTasksByStatus"> = {
        listTasksByStatus: () =>
          Effect.succeed([
            { task: { notesChangeRequested: "tidy my notes" } } as ChannelLedger.ChannelStoredTask,
          ]),
      };
      const writer = yield* makeChannelBotNoteWriter(fs, files, busy);
      const answer = yield* writer.tabEdit(
        { intent: "message", text: goatBotForgetNoteMessage(fridays) },
        "input-1",
        "2026-11-07",
        Effect.succeed(person()),
      );
      assert.strictEqual(answer?.text, CHANNEL_COPY.noteEditBusy);
      assert.strictEqual(yield* fs.readFileString(files.notes), text);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect("a note whose forget was refused during a grant is put back once that work ends", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = channelBotFilesFor(yield* Path.Path, yield* fs.makeTempDirectoryScoped());
      yield* fs.makeDirectory(files.dir, { recursive: true });
      const old = "I deploy on Thursdays.";
      const kept = line(fridays, "b", old);
      yield* fs.writeFileString(files.notes, NOTES_HEADER + line(old, "a") + "\n" + kept + "\n");
      let open = [{ task: { taskId: "tidy", notesChangeRequested: "tidy my notes" } }];
      const ledger: Pick<ChannelLedger.ChannelLedger["Service"], "listTasksByStatus"> = {
        listTasksByStatus: () => Effect.sync(() => open as Array<ChannelLedger.ChannelStoredTask>),
      };
      const writer = yield* makeChannelBotNoteWriter(fs, files, ledger);
      const forget = writer.tabEdit(
        { intent: "message", text: goatBotForgetNoteMessage(fridays) },
        "input-1",
        "2026-11-07",
        Effect.succeed(person()),
      );
      assert.strictEqual((yield* forget)?.text, CHANNEL_COPY.noteEditBusy);
      // The tidy carries out the refused forget by hand anyway.
      const tidied = NOTES_HEADER + line(old, "a") + "\n";
      yield* fs.writeFileString(files.notes, tidied);
      assert.deepStrictEqual(yield* writer.keepRefused(new Set()), []);
      open = [];
      // The task ended but its run is still writing.
      assert.deepStrictEqual(yield* writer.keepRefused(new Set(["tidy"])), []);
      assert.strictEqual(yield* fs.readFileString(files.notes), tidied);
      assert.deepStrictEqual(yield* writer.keepRefused(new Set()), [
        { note: fridays, holders: ["tidy"] },
      ]);
      // Put back as it stood, so the note it corrected stays replaced.
      assert.strictEqual(yield* fs.readFileString(files.notes), tidied + kept + "\n");
      assert.deepStrictEqual(yield* writer.keepRefused(new Set()), []);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect("a refused forget is not put back when the note survived or was forgotten later", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = channelBotFilesFor(yield* Path.Path, yield* fs.makeTempDirectoryScoped());
      yield* fs.makeDirectory(files.dir, { recursive: true });
      const staging = "Staging is staging-02.";
      const text = NOTES_HEADER + line(fridays, "a") + "\n" + line(staging, "b") + "\n";
      yield* fs.writeFileString(files.notes, text);
      let open = [{ task: { taskId: "tidy", notesChangeRequested: "tidy my notes" } }];
      const ledger: Pick<ChannelLedger.ChannelLedger["Service"], "listTasksByStatus"> = {
        listTasksByStatus: () => Effect.sync(() => open as Array<ChannelLedger.ChannelStoredTask>),
      };
      const writer = yield* makeChannelBotNoteWriter(fs, files, ledger);
      const forget = (note: string) =>
        Effect.map(
          writer.tabEdit(
            { intent: "message", text: goatBotForgetNoteMessage(note) },
            "input-1",
            "2026-11-07",
            Effect.succeed(person()),
          ),
          (answer) => answer?.text,
        );
      assert.strictEqual(yield* forget(fridays), CHANNEL_COPY.noteEditBusy);
      assert.strictEqual(yield* forget(staging), CHANNEL_COPY.noteEditBusy);
      open = [];
      // The person asks again once the tidy is over, and that forget goes through.
      assert.strictEqual(yield* forget(staging), CHANNEL_COPY.noteForgotten);
      // The tidy left the other note in place; a later tidy removes it on purpose.
      assert.deepStrictEqual(yield* writer.keepRefused(new Set()), []);
      open = [{ task: { taskId: "later", notesChangeRequested: "tidy my notes again" } }];
      yield* fs.writeFileString(files.notes, NOTES_HEADER);
      open = [];
      assert.deepStrictEqual(yield* writer.keepRefused(new Set()), []);
      assert.strictEqual(yield* fs.readFileString(files.notes), NOTES_HEADER);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect(
    "a note reception saves waits while a task may edit the notes, unless that input saved it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const files = channelBotFilesFor(yield* Path.Path, yield* fs.makeTempDirectoryScoped());
        yield* fs.makeDirectory(files.dir, { recursive: true });
        const text = NOTES_HEADER + line("Staging is staging-02.", "input-2") + "\n";
        yield* fs.writeFileString(files.notes, text);
        const busy: Pick<ChannelLedger.ChannelLedger["Service"], "listTasksByStatus"> = {
          listTasksByStatus: () =>
            Effect.succeed([
              {
                task: { notesChangeRequested: "tidy my notes" },
              } as ChannelLedger.ChannelStoredTask,
            ]),
        };
        const writer = yield* makeChannelBotNoteWriter(fs, files, busy);
        assert.strictEqual(
          yield* writer.save(fridays, "2026-11-07", "input-1"),
          CHANNEL_COPY.noteEditBusy,
        );
        // A restart re-runs an input whose note was saved before the grant opened.
        assert.isUndefined(yield* writer.save("Staging is staging-02.", "2026-11-07", "input-2"));
        assert.strictEqual(yield* fs.readFileString(files.notes), text);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a re-run while a task may edit the notes never writes, even after the hand edit", () =>
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem;
      const files = channelBotFilesFor(yield* Path.Path, yield* real.makeTempDirectoryScoped());
      yield* real.makeDirectory(files.dir, { recursive: true });
      const saved = NOTES_HEADER + line("Staging is staging-02.", "input-2") + "\n";
      let writes = 0;
      // The granted task's hand edit removes the line right after GOAT found it there.
      const fs: FileSystem.FileSystem = {
        ...real,
        readFileString: (path, encoding) =>
          Effect.andThen(
            real.writeFileString(files.notes, NOTES_HEADER),
            real.readFileString(path, encoding),
          ),
        writeFileString: (path, data, options) => {
          writes += 1;
          return real.writeFileString(path, data, options);
        },
      };
      const busy: Pick<ChannelLedger.ChannelLedger["Service"], "listTasksByStatus"> = {
        listTasksByStatus: () =>
          Effect.succeed([
            { task: { notesChangeRequested: "tidy my notes" } } as ChannelLedger.ChannelStoredTask,
          ]),
      };
      const writer = yield* makeChannelBotNoteWriter(fs, files, busy);
      yield* real.writeFileString(files.notes, saved);
      assert.isUndefined(yield* writer.save("Staging is staging-02.", "2026-11-07", "input-2"));
      yield* real.writeFileString(files.notes, saved);
      assert.deepStrictEqual(
        yield* writer.saveIf(
          Effect.succeed("busy"),
          "Staging is staging-02.",
          "2026-11-07",
          "input-2",
        ),
        { notice: undefined },
      );
      assert.strictEqual(writes, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a forget leaves the file untouched when it changes before the rename, twice", () => {
    let writes = 0;
    return Effect.gen(function* () {
      const text = NOTES_HEADER + line(fridays, "a") + "\n";
      const fs = yield* FileSystem.FileSystem;
      const files = channelBotFilesFor(yield* Path.Path, yield* fs.makeTempDirectoryScoped());
      yield* fs.makeDirectory(files.dir, { recursive: true });
      yield* fs.writeFileString(files.notes, text);
      const appended = (n: number) => line("Hand edit " + n + ".", "hand-" + n) + "\n";
      const beforeCompare = Effect.suspend(() => {
        writes++;
        return fs.writeFileString(files.notes, appended(writes), { flag: "a" }).pipe(Effect.orDie);
      });
      const writer = yield* makeChannelBotNoteWriter(fs, files, noOpenTasks, { beforeCompare });
      const answer = yield* writer.tabEdit(
        { intent: "message", text: goatBotForgetNoteMessage(fridays) },
        "input-1",
        "2026-11-07",
        Effect.succeed(person()),
      );
      assert.strictEqual(answer?.text, CHANNEL_COPY.noteEditFailed);
      assert.strictEqual(yield* fs.readFileString(files.notes), text + appended(1) + appended(2));
      assert.deepStrictEqual(
        (yield* fs.readDirectory(files.dir)).filter((name) => name.startsWith("memory.md.")),
        [],
      );
    }).pipe(Effect.scoped, Effect.provide(services));
  });

  it.effect("a forget says so when the note came back right after the rename", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = channelBotFilesFor(yield* Path.Path, yield* fs.makeTempDirectoryScoped());
      yield* fs.makeDirectory(files.dir, { recursive: true });
      const text = NOTES_HEADER + line(fridays, "a") + "\n";
      yield* fs.writeFileString(files.notes, text);
      // Another writer puts back the copy it read before the rename.
      const afterRename = fs.writeFileString(files.notes, text).pipe(Effect.orDie);
      const writer = yield* makeChannelBotNoteWriter(fs, files, noOpenTasks, { afterRename });
      const answer = yield* writer.tabEdit(
        { intent: "message", text: goatBotForgetNoteMessage(fridays) },
        "input-1",
        "2026-11-07",
        Effect.succeed(person()),
      );
      assert.strictEqual(answer?.text, CHANNEL_COPY.noteCameBack);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect.skipIf(windowsHost)(
    "a forget that cannot read the file afterwards says it could not check",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const files = channelBotFilesFor(yield* Path.Path, yield* fs.makeTempDirectoryScoped());
        yield* fs.makeDirectory(files.dir, { recursive: true });
        yield* fs.writeFileString(files.notes, NOTES_HEADER + line(fridays, "a") + "\n");
        const afterRename = Effect.gen(function* () {
          yield* fs.remove(files.notes);
          NodeChildProcess.execFileSync("mkfifo", [files.notes]);
        }).pipe(Effect.orDie);
        const writer = yield* makeChannelBotNoteWriter(fs, files, noOpenTasks, { afterRename });
        const answer = yield* writer.tabEdit(
          { intent: "message", text: goatBotForgetNoteMessage(fridays) },
          "input-1",
          "2026-11-07",
          Effect.succeed(person()),
        );
        assert.strictEqual(answer?.text, CHANNEL_COPY.noteUnverified);
      }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect("a forget keeps a byte order mark and never touches a file at another name", () =>
    Effect.gen(function* () {
      const keep = line("Keep me.", "b") + "\n";
      const { edit, read, fs, files } = yield* setup(
        "\uFEFF" + NOTES_HEADER + line(fridays, "a") + "\n" + keep,
      );
      yield* fs.writeFileString(files.notes + ".edit", "someone else's file");
      assert.strictEqual(
        yield* edit(goatBotForgetNoteMessage(fridays)),
        CHANNEL_COPY.noteForgotten,
      );
      assert.strictEqual(yield* fs.readFileString(files.notes + ".edit"), "someone else's file");
      const bytes = yield* fs.readFile(files.notes);
      assert.deepStrictEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      assert.strictEqual((yield* read).replace(/^\uFEFF/u, ""), NOTES_HEADER + keep);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect("a forget leaves a file that is not UTF-8 exactly as it was", () =>
    Effect.gen(function* () {
      const { edit, fs, files } = yield* setup("");
      const encoded = new TextEncoder().encode(NOTES_HEADER + line(fridays, "a") + "\n");
      const original = new Uint8Array([...encoded, 0xff, 0xfe, 0x0a]);
      yield* fs.writeFile(files.notes, original);
      assert.strictEqual(
        yield* edit(goatBotForgetNoteMessage(fridays)),
        CHANNEL_COPY.noteEditFailed,
      );
      assert.deepStrictEqual([...(yield* fs.readFile(files.notes))], [...original]);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect("a forget removes a long correction chain and keeps the notes around it", () =>
    Effect.gen(function* () {
      const step = (at: number) => "Release day is number " + at + ".";
      const chain = Array.from({ length: 4_000 }, (_, at) =>
        line(step(at), "c" + at, at === 0 ? undefined : step(at - 1)),
      );
      const keep = line("Keep me.", "k") + "\n";
      const { edit, read } = yield* setup(NOTES_HEADER + keep + chain.join("\n") + "\n");
      assert.strictEqual(
        yield* edit(goatBotForgetNoteMessage(step(3_999))),
        CHANNEL_COPY.noteForgotten,
      );
      assert.strictEqual(yield* read, NOTES_HEADER + keep);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect("a file over 1 MiB is not edited", () =>
    Effect.gen(function* () {
      const filler = line("x".repeat(400), "fill") + "\n";
      const text = NOTES_HEADER + line(fridays, "a") + "\n" + filler.repeat(2_700);
      const { edit, read } = yield* setup(text);
      assert.strictEqual(
        yield* edit(goatBotForgetNoteMessage(fridays)),
        CHANNEL_COPY.noteFileTooLarge,
      );
      assert.strictEqual((yield* read).length, text.length);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});

const memoryUpdated = Effect.gen(function* () {
  yield* (yield* ChannelBotEvents.ChannelBotEvents).flush;
  const records = yield* botMessages;
  return records.turnItems.flatMap((item) =>
    item.type === "notification" && item.source.kind === "goat_bot_event" ? [item.summary] : [],
  );
});

/** Reception answers remember itself, so a session does not take the message first. */
const receptionRouting = Effect.flatMap(ServerSettings.ServerSettingsService, (settings) =>
  settings.updateSettings({ goatBotSessionRouting: "reception" }),
);

const remembering = (decide: (text: string) => Partial<ChannelReceptionResult>) => {
  const harness = makeHarness();
  harness.script.current = (input) => {
    if (input.mode !== "input") return defaultScript(input);
    return Effect.succeed({
      replyText: "Got it.",
      action: { type: "report_only" },
      ...decide(input.inputText ?? ""),
    });
  };
  return harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
};

const serverNotes = Effect.gen(function* () {
  return channelBotFilesFor(yield* Path.Path, (yield* ServerConfig.ServerConfig).stateDir);
});

describe("a Memory updated line when notes change outside the GOAT app", () => {
  it.effect(
    "a Slack remember that saves leaves one line, and that input saved again leaves none",
    () => {
      const layer = remembering((text) =>
        text.startsWith("remember that") ? { remember: fridays, rememberQuote: text } : {},
      );
      return Effect.gen(function* () {
        yield* setupBot;
        yield* receptionRouting;
        yield* linkSlackUser();
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const fs = yield* FileSystem.FileSystem;
        const files = yield* serverNotes;
        yield* gateway.ingest(
          slackInput("remember that I deploy on Fridays", "slack-save"),
          slackContext,
        );
        yield* runtime.drain;
        assert.include(yield* fs.readFileString(files.notes), fridays);
        assert.deepStrictEqual(yield* memoryUpdated, ["Memory updated"]);

        const again = slackInput("remember that I deploy on Fridays", "slack-again");
        yield* appendChannelBotNote(
          fs,
          files,
          fridays,
          "2026-11-07T10:00:00.000Z",
          inputIdFor({
            ...again,
            ownerId,
          }),
        );
        const before = yield* fs.readFileString(files.notes);
        yield* gateway.ingest(again, slackContext);
        yield* runtime.drain;
        assert.strictEqual(yield* fs.readFileString(files.notes), before);
        assert.deepStrictEqual(yield* memoryUpdated, ["Memory updated"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a remember from the GOAT app leaves no line", () => {
    const layer = remembering(() => ({
      remember: "I deploy on Mondays.",
      rememberQuote: "remember that I deploy on Mondays",
    }));
    return Effect.gen(function* () {
      yield* setupBot;
      yield* receptionRouting;
      const fs = yield* FileSystem.FileSystem;
      const files = yield* serverNotes;
      yield* (yield* ChannelGateway.ChannelGateway).ingest(
        goatInput("remember that I deploy on Mondays", "goat-save"),
        rpcContext,
      );
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      assert.include(yield* fs.readFileString(files.notes), "I deploy on Mondays.");
      assert.deepStrictEqual(yield* memoryUpdated, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a refused remember and a change that finds nothing leave no line", () => {
    const layer = remembering(() => ({
      remember: fridays,
      rememberQuote: "please remember Fridays",
    }));
    return Effect.gen(function* () {
      yield* setupBot;
      yield* receptionRouting;
      yield* linkSlackUser();
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const fs = yield* FileSystem.FileSystem;
      const files = yield* serverNotes;
      yield* gateway.ingest(slackInput("hello there", "refused"), slackContext);
      yield* runtime.drain;
      assert.strictEqual(yield* fs.exists(files.notes), false);
      yield* gateway.ingest(
        slackInput(goatBotChangeNoteMessage("no such note", "Still nothing."), "missing"),
        slackContext,
      );
      yield* runtime.drain;
      assert.deepStrictEqual(yield* memoryUpdated, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "a Slack forget that removes a note leaves one line; the same forget from the app leaves none",
    () => {
      const layer = remembering(() => ({}));
      return Effect.gen(function* () {
        yield* setupBot;
        yield* receptionRouting;
        yield* linkSlackUser();
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const fs = yield* FileSystem.FileSystem;
        const files = yield* serverNotes;
        yield* appendChannelBotNote(fs, files, fridays, "2026-11-01T10:00:00.000Z", "earlier");
        yield* gateway.ingest(
          slackInput(goatBotForgetNoteMessage(fridays), "slack-forget"),
          slackContext,
        );
        yield* runtime.drain;
        assert.notInclude(yield* fs.readFileString(files.notes), fridays);
        assert.deepStrictEqual(yield* memoryUpdated, ["Memory updated"]);

        yield* appendChannelBotNote(
          fs,
          files,
          "I deploy on Mondays.",
          "2026-11-02T10:00:00.000Z",
          "later",
        );
        yield* gateway.ingest(
          goatInput(goatBotForgetNoteMessage("I deploy on Mondays."), "goat-forget"),
          rpcContext,
        );
        yield* runtime.drain;
        assert.notInclude(yield* fs.readFileString(files.notes), "I deploy on Mondays.");
        assert.deepStrictEqual(yield* memoryUpdated, ["Memory updated"]);
      }).pipe(Effect.provide(layer));
    },
  );
});
