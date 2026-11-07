import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ChannelGatewayError, EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ChannelBotHome from "./ChannelBotHome.ts";
import * as ChannelBotNotesReader from "./ChannelBotNotesReader.ts";
import { channelNotesRevision } from "./channelBriefs.ts";
import { appendChannelBotNote, channelBotFilesFor, NOTES_HEADER } from "./channelBotNotes.ts";

const homeHere = Layer.succeed(
  ChannelBotHome.ChannelBotHome,
  ChannelBotHome.ChannelBotHome.of({
    requireHome: Effect.void,
    read: Effect.die("unused"),
    claimHere: () => Effect.die("unused"),
  }),
);
const homeElsewhere = Layer.succeed(
  ChannelBotHome.ChannelBotHome,
  ChannelBotHome.ChannelBotHome.of({
    requireHome: Effect.fail(
      new ChannelGatewayError({
        reason: "not_home",
        homeEnvironmentId: EnvironmentId.make("environment:home"),
      }),
    ),
    read: Effect.die("unused"),
    claimHere: () => Effect.die("unused"),
  }),
);

const readerLayer = (
  options: ChannelBotNotesReader.ReaderOptions = {},
  home: Layer.Layer<ChannelBotHome.ChannelBotHome> = homeHere,
) =>
  Layer.effect(
    ChannelBotNotesReader.ChannelBotNotesReader,
    ChannelBotNotesReader.make(options),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(ServerConfig.layerTest(process.cwd(), { prefix: "goat-bot-notes-" }), home),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const notesFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  const files = channelBotFilesFor(path, (yield* ServerConfig.ServerConfig).stateDir);
  yield* (yield* FileSystem.FileSystem).makeDirectory(files.dir, { recursive: true });
  return files;
});

const writeNotes = (text: string | Uint8Array) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* notesFile;
    yield* typeof text === "string"
      ? fs.writeFileString(files.notes, text)
      : fs.writeFile(files.notes, text);
    return files;
  });

const list = Effect.flatMap(ChannelBotNotesReader.ChannelBotNotesReader, (reader) => reader.list);

describe("ChannelBotNotesReader", () => {
  it.effect("lists dated notes newest first without the header or their source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = yield* notesFile;
      yield* appendChannelBotNote(fs, files, "Reply in Korean.", "2026-10-17T10:00:00Z", "input-1");
      yield* appendChannelBotNote(fs, files, "Use pnpm.", "2026-10-18T10:00:00Z", "input(2)");
      const result = yield* list;
      assert.deepStrictEqual(result.notes, [
        { index: 1, date: "2026-10-18", text: "Use pnpm." },
        { index: 0, date: "2026-10-17", text: "Reply in Korean." },
      ]);
      assert.isFalse(result.truncated);
      assert.strictEqual(result.revision, yield* channelNotesRevision(files.notes));
    }).pipe(Effect.provide(readerLayer())),
  );

  it.effect("keeps hand-written lines as undated notes and skips blanks and headings", () =>
    Effect.gen(function* () {
      yield* writeNotes(
        "# My notes\r\n\r\n- 2026-10-17: Say (asked in x) out loud. (asked in input-1)\r\n" +
          "* Prefer short answers\r\nCall me Juni\r\n",
      );
      const result = yield* list;
      assert.deepStrictEqual(result.notes, [
        { index: 2, date: null, text: "Call me Juni" },
        { index: 1, date: null, text: "Prefer short answers" },
        { index: 0, date: "2026-10-17", text: "Say (asked in x) out loud." },
      ]);
    }).pipe(Effect.provide(readerLayer())),
  );

  it.effect("skips the header of a file saved with Windows line endings", () =>
    Effect.gen(function* () {
      yield* writeNotes(
        NOTES_HEADER.replaceAll("\n", "\r\n") + "- 2026-10-17: Use pnpm. (asked in input-1)\r\n",
      );
      assert.deepStrictEqual((yield* list).notes, [
        { index: 0, date: "2026-10-17", text: "Use pnpm." },
      ]);
    }).pipe(Effect.provide(readerLayer())),
  );

  it.effect("returns no notes and no revision when there is no notes file", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* list, { revision: null, notes: [], truncated: false });
    }).pipe(Effect.provide(readerLayer())),
  );

  it.effect("reads only the newest part of a large file and drops the partial first line", () =>
    Effect.gen(function* () {
      const filler = "- 2026-01-01: " + "é".repeat(40) + " (asked in old)\n";
      const body = filler.repeat(2_000) + "- 2026-10-18: Newest. (asked in input-9)\n";
      yield* writeNotes(NOTES_HEADER + body);
      const result = yield* list;
      assert.isTrue(result.truncated);
      assert.deepStrictEqual(result.notes[0], {
        index: result.notes.length - 1,
        date: "2026-10-18",
        text: "Newest.",
      });
      for (const note of result.notes.slice(1)) {
        assert.deepStrictEqual([note.date, note.text], ["2026-01-01", "é".repeat(40)]);
      }
    }).pipe(Effect.provide(readerLayer())),
  );

  it.effect("keeps the first line whole when the newest part starts on a line boundary", () =>
    Effect.gen(function* () {
      const line = "- 2026-10-17: " + "a".repeat(1_024 - 28) + " (asked in i)\n";
      const bytes = new TextEncoder().encode(line.repeat(65));
      assert.strictEqual(bytes.length % 1_024, 0);
      yield* writeNotes(bytes);
      const result = yield* list;
      assert.isTrue(result.truncated);
      assert.lengthOf(result.notes, 64);
      assert.isTrue(result.notes.every((note) => note.date === "2026-10-17"));
    }).pipe(Effect.provide(readerLayer())),
  );

  // The hook runs inside the reader; the test fills it once it has the file system and path.
  const appending = (times: number) => {
    const hook = { current: Effect.void, calls: 0 };
    const afterStat = Effect.suspend(() => {
      hook.calls++;
      return hook.calls > times ? Effect.void : hook.current;
    });
    const arm = (fs: FileSystem.FileSystem, notes: string) => {
      hook.current = Effect.suspend(() =>
        fs.writeFileString(notes, "- 2026-10-18: Later " + hook.calls + ". (asked in i)\n", {
          flag: "a",
        }),
      ).pipe(Effect.orDie);
    };
    return { hook, afterStat, arm };
  };

  it.effect("reads again when the file changes during a read", () => {
    const { hook, afterStat, arm } = appending(1);
    return Effect.gen(function* () {
      const files = yield* writeNotes("- 2026-10-17: First. (asked in input-1)\n");
      arm(yield* FileSystem.FileSystem, files.notes);
      const result = yield* list;
      assert.deepStrictEqual(
        result.notes.map((note) => note.text),
        ["Later 1.", "First."],
      );
      assert.strictEqual(hook.calls, 2);
    }).pipe(Effect.provide(readerLayer({ afterStat })));
  });

  it.effect("fails instead of returning a torn read when the file keeps changing", () => {
    const { hook, afterStat, arm } = appending(Number.POSITIVE_INFINITY);
    return Effect.gen(function* () {
      const files = yield* writeNotes("- 2026-10-17: First. (asked in input-1)\n");
      arm(yield* FileSystem.FileSystem, files.notes);
      const error = yield* Effect.flip(list);
      assert.strictEqual(error.reason, "persistence_failed");
      assert.strictEqual(hook.calls, 3);
    }).pipe(Effect.provide(readerLayer({ afterStat })));
  });

  it.effect("reports a notes path it cannot read as a failure, not as no notes", () =>
    Effect.gen(function* () {
      const files = yield* notesFile;
      yield* (yield* FileSystem.FileSystem).makeDirectory(files.notes);
      const error = yield* Effect.flip(list);
      assert.strictEqual(error.reason, "persistence_failed");
    }).pipe(Effect.provide(readerLayer())),
  );

  it.effect("refuses on a server that is not GOAT Bot's home", () =>
    Effect.gen(function* () {
      yield* writeNotes("- 2026-10-17: First. (asked in input-1)\n");
      const error = yield* Effect.flip(list);
      assert.strictEqual(error.reason, "not_home");
      assert.strictEqual(error.homeEnvironmentId, "environment:home");
    }).pipe(Effect.provide(readerLayer({}, homeElsewhere))),
  );
});
