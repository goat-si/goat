import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  appendChannelBotNote,
  channelBotFilesFor,
  quotedFromInput,
  readChannelBotNotes,
} from "./channelBotNotes.ts";

// A note line carries the day where GOAT runs; dates here are UTC unless a case sets its own zone.
const services = Layer.merge(NodeServices.layer, DateTime.layerCurrentZoneOffset(0));
const seoulServices = Layer.merge(NodeServices.layer, DateTime.layerCurrentZoneNamed("Asia/Seoul"));

describe("quotedFromInput", () => {
  it.each([
    ["remember that", "Always reply in Korean, remember that", true],
    ["  remember \n that  ", "Always reply in Korean, remember\t  that", true],
    ["Reply in Korean", "Reply\n in\t Korean", true],
    ["", "remember that", false],
    ["  \n\t", "remember that", false],
    ["remember that", "", false],
    ["remember that", "What machine is this?", false],
    ["remember that", "Remember that", true],
    ["reply in Korean", "reply in English", false],
    ["Actually I deploy on Mondays.", "Actually I deploy on Mondays", true],
    ["\u201CReply in Korean\u201D", 'Please "reply in Korean"', true],
    ["Use the read\u2011only mode", "use the read-only mode", true],
    ["C++", "I write C", false],
    ["$5", "it costs 5 dollars", false],
    ["deploy", "the deployment is fine", false],
    ["...", "remember that...", false],
    [
      "\uD55C\uAD6D\uC5B4\uB85C \uB2F5\uD574",
      "\uC55E\uC73C\uB85C \uD55C\uAD6D\uC5B4\uB85C \uB2F5\uD574\uC918",
      true,
    ],
    [
      "\uC601\uC5B4\uB85C \uB2F5\uD574",
      "\uC55E\uC73C\uB85C \uD55C\uAD6D\uC5B4\uB85C \uB2F5\uD574\uC918",
      false,
    ],
  ])("matches %j against %j: %s", (quote, input, matches) => {
    expect(quotedFromInput(quote, input)).toBe(matches);
  });

  it("checks a word against a long run of letters without matching inside it", () => {
    expect(quotedFromInput("a", "a".repeat(32_000))).toBe(false);
    expect(quotedFromInput("a", "a".repeat(32_000) + " a")).toBe(true);
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
    expect(yield* readChannelBotNotes(files, "")).toBe(
      "- 2026-10-17: Reply in Korean. (asked in input-1)\n- 2026-10-18: Use pnpm. (asked in input-2)",
    );
    const text = yield* fs.readFileString(files.notes);
    expect(text.match(/# GOAT Bot notes/gu)).toHaveLength(1);
  }).pipe(Effect.provide(services)),
);

// 17:10 UTC is already the next day in Seoul, where the person and GOAT's machine are.
it.effect("dates a note and its correction by the day where GOAT runs, not UTC", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files = channelBotFilesFor(path, yield* fs.makeTempDirectoryScoped());
    yield* appendChannelBotNote(
      fs,
      files,
      "I deploy on Fridays.",
      "2026-11-07T14:59:00Z",
      "input-1",
    );
    yield* appendChannelBotNote(
      fs,
      files,
      "I deploy on Mondays.",
      "2026-11-07T17:10:00Z",
      "input-2",
      "I deploy on Fridays.",
    );
    const text = yield* fs.readFileString(files.notes);
    expect(text).toContain("- 2026-11-07: I deploy on Fridays. (asked in input-1)\n");
    expect(text).toContain(
      '- 2026-11-08: I deploy on Mondays. (asked in input-2) (replaces: "I deploy on Fridays.")\n',
    );
  }).pipe(Effect.provide(seoulServices)),
);

it.effect("creates no notes file for an empty note", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped();
    const files = channelBotFilesFor(path, stateDir);
    yield* appendChannelBotNote(fs, files, " \n\t ", "2026-10-17T10:00:00.000Z", "input-empty");
    expect(yield* fs.exists(files.notes)).toBe(false);
  }).pipe(Effect.provide(services)),
);

describe("corrections, newest wins", () => {
  const fridays = "I deploy on Fridays.";
  const setup = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files = channelBotFilesFor(path, yield* fs.makeTempDirectoryScoped());
    yield* appendChannelBotNote(fs, files, fridays, "2026-11-01T10:00:00Z", "input-1");
    return { fs, files };
  });

  it.effect("a correction hides the note it replaces from the notes every reader gets", () =>
    Effect.gen(function* () {
      const { fs, files } = yield* setup;
      const outcome = yield* appendChannelBotNote(
        fs,
        files,
        "I deploy on Mondays.",
        "2026-11-02T10:00:00Z",
        "input-2",
        fridays,
      );
      expect(outcome).toEqual({ correction: "replaced", wrote: true });
      expect((yield* fs.readFileString(files.notes)).trimEnd().split("\n").at(-1)).toBe(
        '- 2026-11-02: I deploy on Mondays. (asked in input-2) (replaces: "I deploy on Fridays.")',
      );
      expect(yield* readChannelBotNotes(files, "")).toBe(
        '- 2026-11-02: I deploy on Mondays. (asked in input-2) (replaces: "I deploy on Fridays.")',
      );
    }).pipe(Effect.provide(services)),
  );

  it.effect("corrections saved in order leave only the newest, even when both name the first", () =>
    Effect.gen(function* () {
      const { fs, files } = yield* setup;
      yield* appendChannelBotNote(
        fs,
        files,
        "Mondays.",
        "2026-11-02T10:00:00Z",
        "input-2",
        fridays,
      );
      const second = yield* appendChannelBotNote(
        fs,
        files,
        "Tuesdays.",
        "2026-11-03T10:00:00Z",
        "input-3",
        fridays,
      );
      expect(second).toEqual({ correction: "replaced", wrote: true });
      expect(yield* readChannelBotNotes(files, "")).toBe(
        '- 2026-11-03: Tuesdays. (asked in input-3) (replaces: "Mondays.")',
      );
    }).pipe(Effect.provide(services)),
  );

  it.effect("a correction naming the full dated line replaces that note", () =>
    Effect.gen(function* () {
      const { fs, files } = yield* setup;
      const outcome = yield* appendChannelBotNote(
        fs,
        files,
        "Mondays.",
        "2026-11-02T10:00:00Z",
        "input-2",
        "- 2026-11-01:  I deploy on   Fridays. (asked in input-1)",
      );
      expect(outcome).toEqual({ correction: "replaced", wrote: true });
      expect(yield* readChannelBotNotes(files, "")).not.toContain("Fridays. (asked in input-1)\n");
      expect((yield* readChannelBotNotes(files, "")).split("\n")).toHaveLength(1);
    }).pipe(Effect.provide(services)),
  );

  it.effect("an unmatched correction keeps the note plainly and reports it again on a re-run", () =>
    Effect.gen(function* () {
      const { fs, files } = yield* setup;
      for (let pass = 0; pass < 2; pass++) {
        expect(
          yield* appendChannelBotNote(
            fs,
            files,
            "Mondays.",
            "2026-11-02T10:00:00Z",
            "input-2",
            "I deploy on Sundays.",
          ),
        ).toEqual({ correction: "unmatched", wrote: pass === 0 });
      }
      const text = yield* fs.readFileString(files.notes);
      expect(text.match(/asked in input-2/gu)).toHaveLength(1);
      expect(text).not.toContain("(replaces:");
      expect((yield* readChannelBotNotes(files, "")).split("\n")).toHaveLength(2);
    }).pipe(Effect.provide(services)),
  );

  it.effect("deleting the replacing line by hand brings the older note back", () =>
    Effect.gen(function* () {
      const { fs, files } = yield* setup;
      yield* appendChannelBotNote(
        fs,
        files,
        "Mondays.",
        "2026-11-02T10:00:00Z",
        "input-2",
        fridays,
      );
      const text = yield* fs.readFileString(files.notes);
      yield* fs.writeFileString(files.notes, text.replace(/^.*Mondays.*\n/mu, ""));
      expect(yield* readChannelBotNotes(files, "")).toBe(
        "- 2026-11-01: I deploy on Fridays. (asked in input-1)",
      );
    }).pipe(Effect.provide(services)),
  );

  it.effect("only a marker at the end of a line, after its source, replaces a note", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = channelBotFilesFor(path, yield* fs.makeTempDirectoryScoped());
      yield* fs.makeDirectory(files.dir, { recursive: true });
      const lines = [
        "- 2026-01-01: foo (asked in x) (asked in a)",
        '- 2026-01-02: new (asked in channel-input:123) (replaces: "foo (asked in x)")',
        '- 2026-01-03: keep (replaces: "new") (asked in b)',
        "- 2026-01-04: odd (asked in c) (replaces: nope)",
        '- 2026-01-05: say ")" and \\ (asked in in(1)) (replaces: "odd (asked in c) (replaces: nope)")',
        '- 2026-01-06: quoted (asked in d) (replaces: "say \\")\\" and \\\\")',
      ];
      yield* fs.writeFileString(files.notes, lines.join("\n") + "\n");
      expect((yield* readChannelBotNotes(files, "")).split("\n")).toEqual([
        lines[1],
        lines[2],
        lines[5],
      ]);
    }).pipe(Effect.provide(services)),
  );
});
