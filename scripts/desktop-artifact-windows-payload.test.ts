import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  countWindowsPayloadFiles,
  PREPARED_SERVER_CACHE_FILE_LIMIT,
  PreparedServerCacheValidationError,
} from "./desktop-artifact-windows-payload.ts";

const cacheKeys = (count: number) =>
  Array.from({ length: count }, (_, index) => index.toString(16).padStart(8, "0"));

const makePayload = Effect.fn("test.makeWindowsPayload")(function* (input: {
  readonly entries: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packagedAppDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-windows-count-" });
  const cacheDir = path.join(packagedAppDir, "resources", "server-compile-cache");
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  yield* fs.writeFileString(path.join(packagedAppDir, "GOAT.exe"), "electron");
  yield* fs.writeFileString(path.join(packagedAppDir, "resources", "app.asar"), "asar");
  const entries = input.entries.map((file) => ({
    module: `server.asar/apps/server/dist/${file}.mjs`,
    file,
  }));
  yield* fs.writeFileString(
    path.join(cacheDir, "manifest.json"),
    JSON.stringify({ format: 1, runtime: "fixture", entries }),
  );
  for (const file of input.files) yield* fs.writeFileString(path.join(cacheDir, file), "bytecode");
  return packagedAppDir;
});

it.layer(NodeServices.layer, { excludeTestServices: true })("Windows payload file count", (it) => {
  it.effect("keeps a manifest-matched prepared server cache outside the payload budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const keys = cacheKeys(46);
        const packagedAppDir = yield* makePayload({ entries: keys, files: keys });
        assert.equal(yield* countWindowsPayloadFiles(packagedAppDir), 2);
      }),
    ),
  );

  it.effect("rejects a prepared server cache that strays from its manifest or budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const keys = cacheKeys(3);
        const overBudget = cacheKeys(PREPARED_SERVER_CACHE_FILE_LIMIT);
        const cases = [
          { entries: keys, files: [...keys, "stray.node"], detail: "unexpected: stray.node" },
          { entries: keys, files: keys.slice(1), detail: `missing: ${keys[0]}` },
          { entries: overBudget, files: overBudget, detail: "contains 65 files" },
        ];
        for (const testCase of cases) {
          const packagedAppDir = yield* makePayload(testCase);
          const error = yield* countWindowsPayloadFiles(packagedAppDir).pipe(Effect.flip);
          assert.instanceOf(error, PreparedServerCacheValidationError);
          assert.include(error.message, testCase.detail);
        }
      }),
    ),
  );
});
