import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

import * as Config from "../config.ts";
import * as PenDepartureRecord from "./PenDepartureRecord.ts";

const layer = Config.layerTest(process.cwd(), { prefix: "goat-pen-departure-record-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect("a write that stops part way keeps the previous record whole for the next start", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const member = { mesh: "m".repeat(26), self: "s".repeat(26) };
    yield* (yield* PenDepartureRecord.make()).write(member);

    // The disk fills or the process stops after half the departure is written.
    const tornWrites = FileSystem.FileSystem.of({
      ...fileSystem,
      writeFileString: (filePath, data, options) =>
        fileSystem
          .writeFileString(filePath, data.slice(0, Math.floor(data.length / 2)), options)
          .pipe(
            Effect.andThen(
              Effect.fail(
                PlatformError.systemError({
                  _tag: "WriteZero",
                  module: "FileSystem",
                  method: "writeFileString",
                  pathOrDescriptor: filePath,
                }),
              ),
            ),
          ),
    });
    yield* Effect.gen(function* () {
      const torn = yield* PenDepartureRecord.make();
      expect(torn.initial).toEqual(member);
      yield* torn.write({ left: true });
    }).pipe(Effect.provideService(FileSystem.FileSystem, tornWrites));

    expect((yield* PenDepartureRecord.make()).initial).toEqual(member);
  }).pipe(Effect.provide(layer)),
);
