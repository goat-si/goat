import { EnvironmentThemeFile } from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import { symlinksSupported } from "@goat/shared/testing/symlinks";

const encodeThemeFile = Schema.encodeSync(Schema.fromJsonString(EnvironmentThemeFile));

const NIGHTFALL_THEME: EnvironmentThemeFile = {
  name: "Nightfall",
  appearance: "dark",
  canvas: "#1a1b26",
  accent: "#7aa2f7",
};

const SHARED_THEME: EnvironmentThemeFile = {
  version: 1,
  name: "Shared Light",
  appearance: "light",
  colors: { canvas: "#eff1f5", accent: "#1e66f5" },
};

const withEnvironmentThemes = <A, E>(
  seeds: Readonly<Record<string, string>>,
  body: Effect.Effect<
    A,
    E,
    | EnvironmentTheme.EnvironmentThemeService
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-environment-theme-" });
    const themesDir = path.join(baseDir, "userdata", "themes");
    yield* fs.makeDirectory(themesDir, { recursive: true });
    for (const [filename, contents] of Object.entries(seeds)) {
      yield* fs.writeFileString(path.join(themesDir, filename), contents);
    }

    return yield* body.pipe(
      Effect.provide(
        EnvironmentTheme.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const currentThemes = Effect.gen(function* () {
  const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
  return yield* environmentTheme.current;
});

it.layer(NodeServices.layer)("environment theme", (it) => {
  it.effect("reattaches themes before resyncing and stops watching when its scope closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fail = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const attach = yield* Deferred.make<void>();
      const failAgain = yield* Deferred.make<void>();
      const closedAgain = yield* Deferred.make<void>();
      const scope = yield* Scope.make();
      let attachments = 0;
      let active = 0;
      const controlledFs = FileSystem.FileSystem.of({
        ...fs,
        watch: (_directory, options) =>
          Stream.unwrap(
            Effect.gen(function* () {
              attachments++;
              active++;
              const first = attachments === 1;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  active--;
                }),
              );
              if (!first) yield* Deferred.await(attach);
              options?.onReady?.();
              return first
                ? Stream.fromEffect(
                    Effect.gen(function* () {
                      yield* Deferred.await(fail);
                      return yield* PlatformError.systemError({
                        _tag: "Unknown",
                        module: "FileSystem",
                        method: "watch",
                      });
                    }),
                  ).pipe(Stream.ensuring(Deferred.succeed(closed, undefined)))
                : Stream.fromEffect(
                    Effect.gen(function* () {
                      yield* Deferred.await(failAgain);
                      return yield* PlatformError.systemError({
                        _tag: "Unknown",
                        module: "FileSystem",
                        method: "watch",
                      });
                    }),
                  ).pipe(Stream.ensuring(Deferred.succeed(closedAgain, undefined)));
            }),
          ),
      });
      yield* withEnvironmentThemes(
        {},
        Effect.gen(function* () {
          const service = yield* EnvironmentTheme.EnvironmentThemeService;
          const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
          const seen = yield* Queue.unbounded<ReadonlyArray<{ readonly id: string }>>();
          yield* service.streamChanges.pipe(
            Stream.runForEach((themes) => Queue.offer(seen, themes)),
            Effect.forkScoped,
          );
          assert.deepEqual(yield* Queue.take(seen), []);
          yield* TestClock.adjust("100 millis");
          yield* Deferred.succeed(fail, undefined);
          yield* Deferred.await(closed);
          yield* fs.writeFileString(
            `${environmentThemesDir}/nightfall.json`,
            encodeThemeFile(NIGHTFALL_THEME),
          );
          yield* TestClock.adjust("1100 millis");
          assert.equal(attachments, 2);
          assert.equal(active, 1);
          assert.equal(yield* Queue.size(seen), 0);
          yield* fs.writeFileString(
            `${environmentThemesDir}/shared-light.json`,
            encodeThemeFile(SHARED_THEME),
          );
          yield* Deferred.succeed(attach, undefined);
          yield* TestClock.adjust("100 millis");
          assert.deepEqual(
            (yield* Queue.take(seen)).map((theme) => theme.id),
            ["nightfall", "shared-light"],
          );
          yield* Deferred.succeed(failAgain, undefined);
          yield* Deferred.await(closedAgain);
        }),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, controlledFs),
        Scope.provide(scope),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );
      assert.equal(active, 0);
      yield* TestClock.adjust("60 seconds");
      assert.equal(attachments, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("follows the directory rather than the set read at start", () =>
    withEnvironmentThemes(
      { "nightfall.json": encodeThemeFile(NIGHTFALL_THEME) },
      Effect.gen(function* () {
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* fs.writeFileString(
          path.join(environmentThemesDir, "shared-light.json"),
          encodeThemeFile(SHARED_THEME),
        );
        assert.equal((yield* currentThemes).length, 2);

        yield* fs.remove(path.join(environmentThemesDir, "nightfall.json"));
        assert.deepEqual(
          (yield* currentThemes).map((theme) => theme.id),
          ["shared-light"],
        );
      }),
    ),
  );

  it.effect("never replays a set older than the snapshot it started from", () =>
    withEnvironmentThemes(
      { "nightfall.json": encodeThemeFile(NIGHTFALL_THEME) },
      Effect.gen(function* () {
        const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* fs.writeFileString(
          path.join(environmentThemesDir, "shared-light.json"),
          encodeThemeFile(SHARED_THEME),
        );
        const seen = yield* Queue.unbounded<ReadonlyArray<{ readonly id: string }>>();
        yield* Stream.runForEach(environmentTheme.streamChanges, (themes) =>
          Queue.offer(seen, themes),
        ).pipe(Effect.forkScoped);
        assert.deepEqual(
          (yield* Queue.take(seen)).map((theme) => theme.id),
          ["nightfall", "shared-light"],
        );
        yield* fs.remove(path.join(environmentThemesDir, "nightfall.json"));
        yield* currentThemes;
        assert.deepEqual(
          (yield* Queue.take(seen)).map((theme) => theme.id),
          ["shared-light"],
        );
      }),
    ),
  );

  it.effect("skips invalid files while keeping valid ones", () =>
    withEnvironmentThemes(
      {
        "nightfall.json": encodeThemeFile(NIGHTFALL_THEME),
        "unresolved.json":
          '{ "name": "X", "appearance": "dark", "canvas": "{{ background }}", "accent": "#7aa2f7" }',
        "malformed.json": "{ not json",
        "no-colors.json": '{ "name": "Empty", "appearance": "dark" }',
        "Bad Name.json": encodeThemeFile(SHARED_THEME),
        "ocean.json": encodeThemeFile(SHARED_THEME),
        "dark.json": encodeThemeFile(SHARED_THEME),
        "notes.txt": "not a theme",
      },
      Effect.gen(function* () {
        assert.deepEqual(
          (yield* currentThemes).map((theme) => theme.id),
          ["nightfall"],
        );
      }),
    ),
  );

  it.effect.skipIf(!symlinksSupported)("ignores a symlinked theme file", () =>
    withEnvironmentThemes(
      {},
      Effect.gen(function* () {
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = path.join(environmentThemesDir, "..", "outside.json");
        yield* fs.writeFileString(outside, encodeThemeFile(NIGHTFALL_THEME));
        yield* fs.symlink(outside, path.join(environmentThemesDir, "nightfall.json"));
        assert.deepEqual(yield* currentThemes, []);
      }),
    ),
  );

  it.effect("does not charge skipped files against the total size limit", () =>
    withEnvironmentThemes(
      {
        ...Object.fromEntries(
          Array.from({ length: 7 }, (_, index) => [`junk-${index}.json`, "{".repeat(30_000)]),
        ),
        "zz-valid.json": encodeThemeFile(NIGHTFALL_THEME),
      },
      Effect.gen(function* () {
        assert.deepEqual(
          (yield* currentThemes).map((theme) => theme.id),
          ["zz-valid"],
        );
      }),
    ),
  );
});
