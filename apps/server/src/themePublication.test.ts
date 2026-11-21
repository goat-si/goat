import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { ServerSettingsError } from "@goat/contracts";
import * as ServerConfig from "./config.ts";
import * as Settings from "./serverSettings.ts";
import * as ThemePublication from "./themePublication.ts";

const theme = {
  name: "Nightfall",
  appearance: "dark",
  canvas: "#112233",
  accent: "#aabbcc",
} as const;

it.layer(NodeServices.layer)("theme publication", (it) => {
  it.effect("records a dated stock reset requested by an agent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "goat-theme-reset-" });
        const layer = ThemePublication.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Settings.layerTest({ enableAgentThemeWrites: true, defaultTheme: "grove" }),
              ServerConfig.layerTest(process.cwd(), base),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          yield* (yield* ThemePublication.ThemePublicationService).set(
            { themeId: "", agent: true },
            Effect.void,
          );
          const settings = yield* (yield* Settings.ServerSettingsService).getSettings;
          assert.equal(settings.defaultTheme, "");
          assert.isNotEmpty(settings.defaultThemeSetAt);
        }).pipe(Effect.provide(layer));
      }),
    ),
  );
  it.effect("can set appearance alone without changing the selected theme", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "goat-theme-publish-" });
        const layer = ThemePublication.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Settings.layerTest({ enableAgentThemeWrites: true, defaultTheme: "grove" }),
              ServerConfig.layerTest(process.cwd(), base),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* ThemePublication.ThemePublicationService;
          yield* service.set({ appearance: "dark", agent: true }, Effect.void);
          const result = yield* (yield* Settings.ServerSettingsService).getSettings;
          assert.equal(result.defaultTheme, "grove");
          assert.equal(result.defaultAppearance, "dark");
          assert.isNotEmpty(result.defaultAppearanceSetAt);
          yield* service.set({ appearance: "invalid", agent: true }, Effect.void).pipe(Effect.flip);
        }).pipe(Effect.provide(layer));
      }),
    ),
  );
  it.effect("rolls back a theme the bounded watcher cannot publish", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "goat-theme-publish-" });
        const folder = path.join(base, "userdata", "themes");
        yield* fs.makeDirectory(folder, { recursive: true });
        for (let index = 0; index < 6; index++) {
          yield* fs.writeFileString(
            path.join(folder, `a${index}.json`),
            JSON.stringify(theme) + " ".repeat(31_000),
          );
        }
        const layer = ThemePublication.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Settings.layerTest({ enableAgentThemeWrites: true }),
              ServerConfig.layerTest(process.cwd(), base),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* ThemePublication.ThemePublicationService;
          const css = '[data-slot="sidebar"]{color:red}'.repeat(300);
          yield* service
            .set({ themeId: "zzz", theme: { ...theme, css }, agent: true }, Effect.void)
            .pipe(Effect.flip);
          assert.isFalse(yield* fs.exists(path.join(folder, "zzz.json")));
          assert.equal(
            (yield* (yield* Settings.ServerSettingsService).getSettings).defaultTheme,
            "",
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
  );
  it.effect("never writes through a theme file symlink", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "goat-theme-publish-" });
        const folder = path.join(base, "userdata", "themes");
        yield* fs.makeDirectory(folder, { recursive: true });
        const outside = path.join(base, "outside.json");
        yield* fs.writeFileString(outside, "unchanged");
        yield* fs.symlink(outside, path.join(folder, "nightfall.json"));
        const layer = ThemePublication.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Settings.layerTest({ enableAgentThemeWrites: true }),
              ServerConfig.layerTest(process.cwd(), base),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* ThemePublication.ThemePublicationService;
          yield* service
            .set({ themeId: "nightfall", theme, agent: true }, Effect.void)
            .pipe(Effect.flip);
          assert.equal(yield* fs.readFileString(outside), "unchanged");
        }).pipe(Effect.provide(layer));
      }),
    ),
  );
  it.effect("refuses unsafe theme IDs, reserved names and invalid CSS", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "goat-theme-publish-" });
        const layer = ThemePublication.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Settings.layerTest({ enableAgentThemeWrites: true }),
              ServerConfig.layerTest(process.cwd(), base),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* ThemePublication.ThemePublicationService;
          for (const input of [
            { themeId: "../escape", theme, agent: true },
            { themeId: "grove", theme, agent: true },
            {
              themeId: "unsafe",
              theme: { ...theme, css: '@import "https://evil.example";' },
              agent: true,
            },
          ])
            yield* service.set(input, Effect.void).pipe(Effect.flip);
          assert.equal(
            (yield* (yield* Settings.ServerSettingsService).getSettings).defaultTheme,
            "",
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
  );
  it.effect("publishes and selects a theme, refreshes selection, and clears it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "goat-theme-publish-" });
        const layer = ThemePublication.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Settings.layerTest({ enableAgentThemeWrites: true }),
              ServerConfig.layerTest(process.cwd(), base),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* ThemePublication.ThemePublicationService;
          const settings = yield* Settings.ServerSettingsService;
          yield* service.set({ themeId: "nightfall", theme, agent: true }, Effect.void);
          assert.isTrue(yield* fs.exists(path.join(base, "userdata", "themes", "nightfall.json")));
          const first = yield* settings.getSettings;
          assert.equal(first.defaultTheme, "nightfall");
          yield* TestClock.adjust("1 second");
          yield* service.set({ themeId: "nightfall", agent: true }, Effect.void);
          assert.notEqual((yield* settings.getSettings).defaultThemeSetAt, first.defaultThemeSetAt);
          yield* service.set({ themeId: "", agent: true }, Effect.void);
          const cleared = yield* settings.getSettings;
          assert.equal(cleared.defaultTheme, "");
          assert.isNotEmpty(cleared.defaultThemeSetAt);
        }).pipe(Effect.provide(layer));
      }),
    ),
  );

  it.effect("rolls back publication if the settings grant is revoked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "goat-theme-publish-" });
        const layer = ThemePublication.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Settings.layerTest({ enableAgentThemeWrites: true }),
              ServerConfig.layerTest(process.cwd(), base),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* ThemePublication.ThemePublicationService;
          const revoked = Effect.fail(
            new ServerSettingsError({ settingsPath: "revoked", operation: "write-file" }),
          );
          yield* service
            .set({ themeId: "nightfall", theme, agent: true }, revoked)
            .pipe(Effect.flip);
          assert.isFalse(yield* fs.exists(path.join(base, "userdata", "themes", "nightfall.json")));
          assert.equal(
            (yield* (yield* Settings.ServerSettingsService).getSettings).defaultTheme,
            "",
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
  );

  it.effect("preserves an existing published theme if authorization is revoked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "goat-theme-publish-" });
        const layer = ThemePublication.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Settings.layerTest({ enableAgentThemeWrites: true }),
              ServerConfig.layerTest(process.cwd(), base),
            ),
          ),
        );
        const folder = path.join(base, "userdata", "themes");
        yield* fs.makeDirectory(folder, { recursive: true });
        const destination = path.join(folder, "nightfall.json");
        const previous = JSON.stringify({ ...theme, name: "Previous" });
        yield* fs.writeFileString(destination, previous);
        yield* Effect.gen(function* () {
          const service = yield* ThemePublication.ThemePublicationService;
          const revoked = Effect.fail(
            new ServerSettingsError({ settingsPath: "revoked", operation: "write-file" }),
          );
          yield* service
            .set({ themeId: "nightfall", theme, agent: true }, revoked)
            .pipe(Effect.flip);
          assert.equal(yield* fs.readFileString(destination), previous);
        }).pipe(Effect.provide(layer));
      }),
    ),
  );
  it.effect("rejects agent publication when disabled without creating files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "goat-theme-publish-" });
        const layer = ThemePublication.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(Settings.layerTest(), ServerConfig.layerTest(process.cwd(), base)),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* ThemePublication.ThemePublicationService;
          yield* service
            .set({ themeId: "nightfall", theme, agent: true }, Effect.void)
            .pipe(Effect.flip);
          assert.isFalse(yield* fs.exists(path.join(base, "userdata", "themes", "nightfall.json")));
          const settings = yield* Settings.ServerSettingsService;
          assert.equal((yield* settings.getSettings).defaultTheme, "");
        }).pipe(Effect.provide(layer));
      }),
    ),
  );
});
