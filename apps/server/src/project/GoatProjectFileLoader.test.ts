import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import { GOAT_PROJECT_FILE_NAME } from "@goat/contracts";
import { LEGACY_PROJECT_FILE_NAME } from "@goat/contracts/legacyT3Names";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GoatProjectFileLoader from "./GoatProjectFileLoader.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(GoatProjectFileLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "goat-project-file-",
  });
});

const writeProjectFile = Effect.fn("writeProjectFile")(function* (
  cwd: string,
  contents: string,
  fileName = GOAT_PROJECT_FILE_NAME,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(cwd, fileName), contents).pipe(Effect.orDie);
});

it.layer(layerTest)("GoatProjectFileLoader", (it) => {
  describe("load", () => {
    it.effect("loads and decodes a valid goat.json", () =>
      Effect.gen(function* () {
        const loader = yield* GoatProjectFileLoader.GoatProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(
          cwd,
          `{
            // JSONC is tolerated
            "iconPath": "assets/logo.svg",
            "scripts": [{ "name": "Dev", "command": "pnpm dev" }],
          }`,
        );

        const loaded = yield* loader.load(cwd);

        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          expect(loaded.value.iconPath).toBe("assets/logo.svg");
          expect(loaded.value.scripts).toEqual([{ name: "Dev", command: "pnpm dev" }]);
        }
      }),
    );

    it.effect("returns none when both project files are missing", () =>
      Effect.gen(function* () {
        const loader = yield* GoatProjectFileLoader.GoatProjectFileLoader;
        const cwd = yield* makeTempDir;

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("prefers goat.json over a legacy file", () =>
      Effect.gen(function* () {
        const loader = yield* GoatProjectFileLoader.GoatProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, '{ "iconPath": "new.svg" }');
        yield* writeProjectFile(cwd, '{ "iconPath": "old.svg" }', LEGACY_PROJECT_FILE_NAME);
        expect(Option.getOrNull(yield* loader.load(cwd))?.iconPath).toBe("new.svg");
      }),
    );

    it.effect("falls back to the legacy project file", () =>
      Effect.gen(function* () {
        const loader = yield* GoatProjectFileLoader.GoatProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, '{ "iconPath": "old.svg" }', LEGACY_PROJECT_FILE_NAME);
        expect(Option.getOrNull(yield* loader.load(cwd))?.iconPath).toBe("old.svg");
      }),
    );

    it.effect("reports invalid goat.json without falling back", () =>
      Effect.gen(function* () {
        const loader = yield* GoatProjectFileLoader.GoatProjectFileLoader;
        const cwd = yield* makeTempDir;
        const warnings: Array<unknown> = [];
        yield* writeProjectFile(cwd, "{ not json");
        yield* writeProjectFile(cwd, '{ "iconPath": "old.svg" }', LEGACY_PROJECT_FILE_NAME);
        const logger = Logger.make(({ message }) => {
          warnings.push(message);
        });
        const loaded = yield* loader
          .load(cwd)
          .pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
        expect(Option.isNone(loaded)).toBe(true);
        expect(warnings).toHaveLength(1);
        expect(warnings.flat()).toEqual([
          expect.objectContaining({
            operation: "decode",
            filePath: expect.stringMatching(/goat\.json$/),
          }),
        ]);
      }),
    );

    it.effect("returns none for malformed JSON without failing", () =>
      Effect.gen(function* () {
        const loader = yield* GoatProjectFileLoader.GoatProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, "{ not json");

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for schema-invalid files without failing", () =>
      Effect.gen(function* () {
        const loader = yield* GoatProjectFileLoader.GoatProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, '{ "scripts": [{ "name": "Dev" }] }');

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );
  });
});
