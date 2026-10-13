import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  migrateRendererOrigin,
  RendererOriginMigrationError,
  type OriginPageRunner,
} from "./DesktopRendererOriginMigration.ts";

const recordingRunner = (calls: Array<{ step: string; url: string; script: string }>) =>
  ((step, url, script) => {
    calls.push({ step, url, script });
    return Effect.succeed(step === "export" ? '{"exported":true}' : '{"records":1}');
  }) satisfies OriginPageRunner;

it.effect("exports from the legacy origin, imports that payload on the new one, then marks", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const markerPath = path.join(yield* fs.makeTempDirectoryScoped(), "marker");
    const calls: Array<{ step: string; url: string; script: string }> = [];
    const input = {
      markerPath,
      legacyOrigin: "t3code://app",
      origin: "goat://app",
      runPage: recordingRunner(calls),
    };

    assert.isTrue(yield* migrateRendererOrigin(input));
    assert.deepEqual(
      calls.map(({ step, url }) => [step, url]),
      [
        ["export", "t3code://app/__goat-origin-migration"],
        ["import", "goat://app/__goat-origin-migration"],
      ],
    );
    assert.include(calls[1]!.script, JSON.stringify('{"exported":true}'));
    assert.equal(yield* fs.readFileString(markerPath), "t3code://app -> goat://app\n");

    // The marker ends it: later launches load no page.
    assert.isFalse(yield* migrateRendererOrigin(input));
    assert.equal(calls.length, 2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("leaves no marker when the import fails, so the next launch retries", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const markerPath = path.join(yield* fs.makeTempDirectoryScoped(), "marker");
    const runPage: OriginPageRunner = (step, url) =>
      step === "export"
        ? Effect.succeed("{}")
        : Effect.fail(new RendererOriginMigrationError({ step, url, cause: new Error("x") }));

    const error = yield* Effect.flip(
      migrateRendererOrigin({
        markerPath,
        legacyOrigin: "t3code://app",
        origin: "goat://app",
        runPage,
      }),
    );
    assert.instanceOf(error, RendererOriginMigrationError);
    assert.equal((error as RendererOriginMigrationError).step, "import");
    assert.isFalse(yield* fs.exists(markerPath));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
