// @effect-diagnostics-next-line nodeBuiltinImport:off -- mkfifo has no Effect API.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  goatBotChangeNoteMessage,
  goatBotForgetNoteMessage,
  type ChannelRequester,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type * as ChannelLedger from "./ChannelLedger.ts";
import { NOTES_HEADER } from "./channelBotNoteLines.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";
import { makeChannelBotNoteWriter, type NoteWriterHooks } from "./channelBotNoteTabEdits.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";

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
    const edit = (message: string, who: ChannelRequester | null = person()) =>
      Effect.map(
        writer.tabEdit(
          { intent: "message", text: message },
          "input-1",
          "2026-11-07T10:00:00Z",
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a change that could name two notes changes nothing", () =>
    Effect.gen(function* () {
      const first = 'Say "hi';
      const second = 'Say "hi" to: "Mina';
      const text = NOTES_HEADER + line(first, "a") + "\n" + line(second, "b") + "\n";
      const { edit, read } = yield* setup(text);
      // Both notes read as the start of this sentence.
      const message = goatBotChangeNoteMessage(second, "Bob");
      assert.isTrue(message.startsWith(goatBotChangeNoteMessage(first, "").slice(0, -1)));
      assert.strictEqual(yield* edit(message), CHANNEL_COPY.noteAmbiguous);
      assert.strictEqual(yield* read, text);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
