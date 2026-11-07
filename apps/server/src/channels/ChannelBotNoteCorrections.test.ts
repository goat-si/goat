import { assert, describe, it } from "@effect/vitest";
import type { ChannelReceptionResult } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import {
  appendChannelBotNote,
  channelBotFilesFor,
  readChannelBotNotes,
} from "./channelBotNotes.ts";
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

/** The spec's correction: the person states the new rule; the model names the note it changes. */
const harnessFor = (decide: (text: string) => Partial<ChannelReceptionResult>) => {
  const harness = makeHarness();
  const seenNotes: Array<string> = [];
  harness.script.current = (input) => {
    if (input.mode !== "input") return defaultScript(input);
    seenNotes.push(input.notes ?? "");
    return Effect.succeed({
      replyText: "Got it.",
      action: { type: "report_only" },
      ...decide(input.inputText ?? ""),
    });
  };
  return { harness, seenNotes };
};

const notesFiles = Effect.gen(function* () {
  const path = yield* Path.Path;
  return channelBotFilesFor(path, (yield* ServerConfig.ServerConfig).stateDir);
});

const send = (text: string, key: string) =>
  Effect.gen(function* () {
    yield* (yield* ChannelGateway.ChannelGateway).ingest(goatInput(text, key), rpcContext);
    yield* (yield* ChannelRuntime.ChannelRuntime).drain;
  });

describe("GOAT Bot note corrections through reception", () => {
  it.effect("a correction leaves only the new rule in the notes the next message sees", () => {
    const { harness, seenNotes } = harnessFor((text) =>
      text.startsWith("Actually")
        ? {
            remember: "I deploy on Mondays.",
            rememberQuote: "Actually I deploy on Mondays",
            replacesNote: fridays,
          }
        : {},
    );
    return Effect.gen(function* () {
      yield* setupBot;
      const fs = yield* FileSystem.FileSystem;
      const files = yield* notesFiles;
      yield* appendChannelBotNote(fs, files, fridays, "2026-11-01T10:00:00Z", "earlier");
      yield* send("Actually I deploy on Mondays", "correct");
      yield* send("When do I deploy?", "ask");
      const next = seenNotes.at(-1) ?? "";
      assert.include(next, "I deploy on Mondays.");
      assert.notInclude(next, "Fridays. (asked in earlier)");
      assert.include(yield* fs.readFileString(files.notes), '(replaces: "I deploy on Fridays.")');
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });

  it.effect("a correction that names no saved note is kept and the reply says so", () => {
    const { harness } = harnessFor(() => ({
      remember: "I deploy on Mondays.",
      rememberQuote: "Actually I deploy on Mondays",
      replacesNote: "I deploy on Sundays.",
    }));
    return Effect.gen(function* () {
      yield* setupBot;
      const fs = yield* FileSystem.FileSystem;
      const files = yield* notesFiles;
      yield* appendChannelBotNote(fs, files, fridays, "2026-11-01T10:00:00Z", "earlier");
      yield* send("Actually I deploy on Mondays", "correct");
      const texts = (yield* botMessages).messages.map((message) => message.text).join("\n");
      assert.include(texts, "Got it. " + CHANNEL_COPY.noteCorrectionUnmatched);
      const saved = yield* fs.readFileString(files.notes);
      assert.include(saved, "I deploy on Mondays.");
      assert.notInclude(saved, "(replaces:");
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });

  it.effect(
    "a pass re-run after the note was saved still tells the person it matched nothing",
    () => {
      const { harness } = harnessFor(() => ({
        remember: "I deploy on Mondays.",
        rememberQuote: "Actually I deploy on Mondays",
        replacesNote: "I deploy on Sundays.",
      }));
      return Effect.gen(function* () {
        yield* setupBot;
        const fs = yield* FileSystem.FileSystem;
        const files = yield* notesFiles;
        // The first pass saved the note, then the server stopped before the result committed.
        const inputId = inputIdFor({ ...goatInput("", "correct"), ownerId });
        yield* appendChannelBotNote(fs, files, fridays, "2026-11-01T10:00:00Z", "earlier");
        yield* appendChannelBotNote(
          fs,
          files,
          "I deploy on Mondays.",
          "2026-11-02T10:00:00Z",
          inputId,
        );
        const saved = yield* fs.readFileString(files.notes);
        yield* send("Actually I deploy on Mondays", "correct");
        const texts = (yield* botMessages).messages.map((message) => message.text).join("\n");
        assert.include(texts, "Got it. " + CHANNEL_COPY.noteCorrectionUnmatched);
        assert.strictEqual(yield* fs.readFileString(files.notes), saved);
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );

  it.effect("a correction the person did not ask for in this message changes nothing", () => {
    const { harness } = harnessFor(() => ({
      remember: "I deploy on Mondays.",
      rememberQuote: "deploy on Mondays from now on",
      replacesNote: fridays,
    }));
    return Effect.gen(function* () {
      yield* setupBot;
      const fs = yield* FileSystem.FileSystem;
      const files = yield* notesFiles;
      yield* appendChannelBotNote(fs, files, fridays, "2026-11-01T10:00:00Z", "earlier");
      const before = yield* fs.readFileString(files.notes);
      yield* send("What day is it?", "unrelated");
      assert.strictEqual(yield* fs.readFileString(files.notes), before);
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });

  it.effect("a note that cannot be saved is reported in the reply", () => {
    const { harness } = harnessFor(() => ({
      remember: "I deploy on Mondays.",
      rememberQuote: "Remember I deploy on Mondays",
    }));
    return Effect.gen(function* () {
      yield* setupBot;
      const fs = yield* FileSystem.FileSystem;
      // A directory where the notes file belongs makes every read and write fail.
      yield* fs.makeDirectory((yield* notesFiles).notes, { recursive: true });
      yield* send("Remember I deploy on Mondays", "remember");
      const texts = (yield* botMessages).messages.map((message) => message.text).join("\n");
      assert.include(texts, "Got it. " + CHANNEL_COPY.noteNotSaved);
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });

  it.effect("corrections from two conversations at once leave a single rule in force", () => {
    const harness = makeHarness();
    const bothDecided = Deferred.makeUnsafe<void>();
    let deciding = 0;
    harness.script.current = (input) => {
      if (input.mode !== "input") return defaultScript(input);
      const day = (input.inputText ?? "").includes("Tuesdays") ? "Tuesdays" : "Mondays";
      return Effect.gen(function* () {
        // Both receptions decide before either saves, so only the gate can order the saves.
        deciding++;
        if (deciding === 2) yield* Deferred.succeed(bothDecided, undefined);
        yield* Deferred.await(bothDecided);
        return {
          replyText: "Got it.",
          action: { type: "report_only" },
          remember: "I deploy on " + day + ".",
          rememberQuote: "Actually I deploy on " + day,
          replacesNote: fridays,
        } satisfies ChannelReceptionResult;
      });
    };
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const fs = yield* FileSystem.FileSystem;
      const files = yield* notesFiles;
      yield* appendChannelBotNote(fs, files, fridays, "2026-11-01T10:00:00Z", "earlier");
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("Actually I deploy on Mondays", "goat-fix"), rpcContext);
      yield* gateway.ingest(slackInput("Actually I deploy on Tuesdays", "slack-fix"), slackContext);
      yield* (yield* ChannelRuntime.ChannelRuntime).drain;
      assert.strictEqual(deciding, 2);
      const current = (yield* readChannelBotNotes(files, "")).split("\n");
      assert.lengthOf(current, 1);
      assert.match(
        current[0] ?? "",
        /I deploy on (Mondays|Tuesdays)\. .*\(replaces: "I deploy on (Mondays|Tuesdays)\."\)$/u,
      );
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });
});
