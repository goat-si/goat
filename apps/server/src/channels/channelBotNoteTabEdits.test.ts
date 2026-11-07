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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
