import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";

import { channelNotesRevision } from "./channelBriefs.ts";

const fileError = (tag: "NotFound" | "PermissionDenied") =>
  PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method: "readFile",
    pathOrDescriptor: "/notes/memory.md",
  });

describe("channel notes launch revision", () => {
  it.effect("hashes exact content, including a final newline", () =>
    Effect.gen(function* () {
      const hash = yield* channelNotesRevision("/notes/memory.md");
      assert.strictEqual(hash, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
      assert.notStrictEqual(yield* channelNotesRevision("/notes/newline.md"), hash);
    }).pipe(
      Effect.provide(
        FileSystem.layerNoop({
          readFile: (path) =>
            Effect.succeed(new TextEncoder().encode(path.endsWith("newline.md") ? "abc\n" : "abc")),
        }),
      ),
    ),
  );

  it.effect("records null for a missing notes file", () =>
    Effect.gen(function* () {
      assert.isNull(yield* channelNotesRevision("/notes/memory.md"));
    }).pipe(
      Effect.provide(FileSystem.layerNoop({ readFile: () => Effect.fail(fileError("NotFound")) })),
    ),
  );

  it.effect("does not label an unreadable notes file as absent", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(channelNotesRevision("/notes/memory.md"));
      assert.strictEqual(error.reason, "persistence");
    }).pipe(
      Effect.provide(
        FileSystem.layerNoop({ readFile: () => Effect.fail(fileError("PermissionDenied")) }),
      ),
    ),
  );
});
