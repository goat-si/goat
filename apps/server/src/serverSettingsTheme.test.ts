import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Settings from "./serverSettings.ts";
import { ServerSettingsError } from "@goat/contracts";
import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "./config.ts";
import { layerServerSettings } from "./serverSettingsLayers.testkit.ts";

describe("internal default theme settings", () => {
  it.effect("sets appearance atomically and rejects unknown appearance values", () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.setDefaultTheme!({ themeId: "grove", setAt: "first", appearance: "dark" });
      const selected = yield* settings.getSettings;
      expect(selected.defaultAppearance).toBe("dark");
      expect(selected.defaultAppearanceSetAt).toBe("first");
      yield* settings.setDefaultTheme!({
        themeId: "grove",
        setAt: "second",
        appearance: "future",
      }).pipe(Effect.flip);
      expect((yield* settings.getSettings).defaultAppearance).toBe("dark");
    }).pipe(Effect.provide(Settings.layerTest())),
  );
  it.effect("removes both default theme keys from the persisted file on clear", () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* settings.start;
      yield* settings.setDefaultTheme!({ themeId: "grove", setAt: "first" });
      yield* settings.setDefaultTheme!({ themeId: "", setAt: "ignored" });
      const raw = yield* fs.readFileString(config.settingsPath);
      expect(raw).not.toContain('"defaultTheme"');
      expect(raw).not.toContain('"defaultThemeSetAt"');
    }).pipe(Effect.provide(layerServerSettings().pipe(Layer.provideMerge(NodeServices.layer)))),
  );
  it.effect("does not commit after authorization is revoked", () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const revoked = new ServerSettingsError({ settingsPath: "revoked", operation: "write-file" });
      yield* settings.setDefaultTheme!(
        { themeId: "grove", setAt: "first", agent: true },
        Effect.fail(revoked),
      ).pipe(Effect.flip);
      expect((yield* settings.getSettings).defaultTheme).toBe("");
    }).pipe(Effect.provide(Settings.layerTest({ enableAgentThemeWrites: true }))),
  );
  it.effect("refuses agent selection unless the person enabled it", () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const denied = yield* settings.setDefaultTheme!({
        themeId: "grove",
        setAt: "first",
        agent: true,
      }).pipe(Effect.flip);
      expect(denied.settingsPath).toBe("theme:agent-disabled");
      expect((yield* settings.getSettings).defaultTheme).toBe("");
      yield* settings.updateSettings({ enableAgentThemeWrites: true });
      yield* settings.setDefaultTheme!({ themeId: "grove", setAt: "second", agent: true });
      expect((yield* settings.getSettings).defaultTheme).toBe("grove");
    }).pipe(Effect.provide(Settings.layerTest())),
  );
  it.effect("sets, refreshes and clears a default without losing concurrent settings", () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.setDefaultTheme!({ themeId: "grove", setAt: "first" });
      expect((yield* settings.getSettings).defaultThemeSetAt).toBe("first");
      yield* Effect.all(
        [
          settings.setDefaultTheme!({ themeId: "grove", setAt: "second" }),
          settings.updateSettings({ branchNamePrefix: "lane/" }),
        ],
        { concurrency: "unbounded" },
      );
      const next = yield* settings.getSettings;
      expect(next.defaultTheme).toBe("grove");
      expect(next.defaultThemeSetAt).toBe("second");
      expect(next.branchNamePrefix).toBe("lane/");
      yield* settings.setDefaultTheme!({ themeId: "", setAt: "ignored" });
      const cleared = yield* settings.getSettings;
      expect(cleared.defaultTheme).toBe("");
      expect(cleared.defaultThemeSetAt).toBe("");
    }).pipe(Effect.provide(Settings.layerTest())),
  );
});
