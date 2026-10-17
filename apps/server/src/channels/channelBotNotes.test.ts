import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  appendChannelBotNote,
  channelBotFilesFor,
  quotedFromInput,
  readChannelBotNotes,
} from "./channelBotNotes.ts";

describe("quotedFromInput", () => {
  it.each([
    ["remember that", "Always reply in Korean, remember that", true],
    ["  remember \n that  ", "Always reply in Korean, remember\t  that", true],
    ["Reply in Korean", "Reply\n in\t Korean", true],
    ["", "remember that", false],
    ["  \n\t", "remember that", false],
    ["remember that", "", false],
    ["remember that", "What machine is this?", false],
    ["remember that", "Remember that", false],
    ["reply in Korean", "reply in English", false],
  ])("matches %j against %j: %s", (quote, input, matches) => {
    expect(quotedFromInput(quote, input)).toBe(matches);
  });
});

it.effect("appends each input note once as a dated single line with its source", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped();
    const files = channelBotFilesFor(path, stateDir);
    yield* appendChannelBotNote(
      fs,
      files,
      "Reply\n  in Korean.",
      "2026-10-17T10:00:00.000Z",
      "input-1",
    );
    // A repeated pass can phrase the same request differently; input provenance deduplicates it.
    yield* appendChannelBotNote(
      fs,
      files,
      "Always use Korean.",
      "2026-10-18T10:00:00.000Z",
      "input-1",
    );
    yield* appendChannelBotNote(fs, files, "Use pnpm.", "2026-10-18T10:00:00.000Z", "input-2");
    expect(yield* readChannelBotNotes(fs, files)).toBe(
      "- 2026-10-17: Reply in Korean. (asked in input-1)\n- 2026-10-18: Use pnpm. (asked in input-2)",
    );
    const text = yield* fs.readFileString(files.notes);
    expect(text.match(/# GOAT Bot notes/gu)).toHaveLength(1);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("creates no notes file for an empty note", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped();
    const files = channelBotFilesFor(path, stateDir);
    yield* appendChannelBotNote(fs, files, " \n\t ", "2026-10-17T10:00:00.000Z", "input-empty");
    expect(yield* fs.exists(files.notes)).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
