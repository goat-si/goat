import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import { layerServerSettings } from "../serverSettingsLayers.testkit.ts";
import * as CuaDriver from "./CuaDriver.ts";
import * as ComputerUseSettings from "./ComputerUseSettings.ts";

const base = Layer.mergeAll(
  ServerConfig.layerTest("/tmp/computer-use-settings", "/tmp/computer-use-settings").pipe(
    Layer.provide(NodeServices.layer),
  ),
  ServerSettings.layerTest(),
  Layer.mock(Handoffs.Handoffs)({ withComputerUseSettings: (_patch, update) => update }),
);

it.effect("enables computer use only after driver admission and disables it again", () =>
  Effect.gen(function* () {
    const admissions = yield* Ref.make(0);
    const driver = Layer.mock(CuaDriver.CuaDriver)({
      admitEnable: Ref.update(admissions, (count) => count + 1),
    });
    const settings = yield* ServerSettings.ServerSettingsService;
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, driver);
    expect(yield* run(ComputerUseSettings.setEnabled(true))).toEqual({ enabled: true });
    expect((yield* settings.getSettings).enableCua).toBe(true);
    expect(yield* Ref.get(admissions)).toBe(1);
    expect(yield* run(ComputerUseSettings.setEnabled(false))).toEqual({ enabled: false });
    expect((yield* settings.getSettings).enableCua).toBe(false);
    expect(yield* Ref.get(admissions)).toBe(1);
  }).pipe(Effect.provide(base)),
);

it.effect("keeps computer use off and explains a failed driver installation", () =>
  Effect.gen(function* () {
    const driver = Layer.mock(CuaDriver.CuaDriver)({
      admitEnable: Effect.fail(
        new CuaDriver.CuaDriverHostError({
          operation: "install",
          cause: "Driver download failed.",
        }),
      ),
    });
    const failure = yield* ComputerUseSettings.setEnabled(true).pipe(
      Effect.provide(driver),
      Effect.flip,
    );
    expect(failure.code).toBe("computer_use_install_failed");
    expect(failure.message).toBe("Driver download failed.");
    const settings = yield* ServerSettings.ServerSettingsService;
    expect((yield* settings.getSettings).enableCua).toBe(false);
  }).pipe(Effect.provide(base)),
);

it.effect("turns computer use off even when session cleanup is unavailable", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const result = yield* ComputerUseSettings.setEnabled(false).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect((yield* settings.getSettings).enableCua).toBe(false);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest("/tmp/computer-use-settings", "/tmp/computer-use-settings").pipe(
          Layer.provide(NodeServices.layer),
        ),
        ServerSettings.layerTest({ enableCua: true }),
      ),
    ),
  ),
);

it.effect("strict input guards refuse to persist a hard-denied app in the allowed apps list", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ cuaStrictInputGuards: true });
    for (const app of [
      "com.1password.1password",
      "com.apple.systempreferences",
      "com.apple.loginwindow",
      "com.apple.SecurityAgent",
      "com.apple.coreauthd",
      "com.apple.LocalAuthentication.UIAgent",
      "com.apple.keychainaccess",
      "com.apple.ScreenTimeAgent",
      "com.apple.ScreenTimeSettingsAgent",
      "com.apple.ScreenTimeWidgetApplication",
      "com.apple.ScreenTimeViewService",
    ]) {
      const result = yield* Effect.result(settings.updateSettings({ cuaAllowedApps: [app] }));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.message).toContain("protected app");
    }
    expect((yield* settings.getSettings).cuaAllowedApps).toEqual([]);
  }).pipe(Effect.provide(base)),
);

it.effect("retains an organization app deny list in settings", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ cuaDeniedApps: ["com.example.Blocked"] });
    expect((yield* settings.getSettings).cuaDeniedApps).toEqual(["com.example.Blocked"]);
  }).pipe(Effect.provide(base)),
);

it.effect("loads an organization deny list from settings.json", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    yield* fs.writeFileString(
      config.settingsPath,
      JSON.stringify({ cuaDeniedApps: ["com.example.Blocked"] }),
    );
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.start;
    expect((yield* settings.getSettings).cuaDeniedApps).toEqual(["com.example.Blocked"]);
  }).pipe(Effect.provide(layerServerSettings().pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("strict input guards reject protected allowed apps without changing the file", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.start;
    yield* settings.updateSettings({
      cuaStrictInputGuards: true,
      cuaAllowedApps: ["com.example.Editor"],
    });
    const result = yield* Effect.result(
      settings.updateSettings({ cuaAllowedApps: ["COM.1PASSWORD.1PASSWORD"] }),
    );
    expect(result._tag).toBe("Failure");
    expect((yield* settings.getSettings).cuaAllowedApps).toEqual(["com.example.Editor"]);
  }).pipe(Effect.provide(layerServerSettings().pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect(
  "strict input guards load settings while removing protected and duplicate allowed apps",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          cuaStrictInputGuards: true,
          cuaAllowedApps: ["com.example.Editor", "COM.EXAMPLE.EDITOR", "com.1password.1password"],
        }),
      );
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.start;
      expect((yield* settings.getSettings).cuaAllowedApps).toEqual(["com.example.Editor"]);
    }).pipe(Effect.provide(layerServerSettings().pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("without strict input guards a protected allowed app is kept as the person set it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    yield* fs.writeFileString(
      config.settingsPath,
      JSON.stringify({
        cuaAllowedApps: ["com.example.Editor", "COM.EXAMPLE.EDITOR", "com.1password.1password"],
      }),
    );
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.start;
    expect((yield* settings.getSettings).cuaAllowedApps).toEqual([
      "com.example.Editor",
      "com.1password.1password",
    ]);
    yield* settings.updateSettings({
      cuaAllowedApps: ["com.example.Editor", "com.1password.1password", "com.apple.keychainaccess"],
    });
    expect((yield* settings.getSettings).cuaAllowedApps).toEqual([
      "com.example.Editor",
      "com.1password.1password",
      "com.apple.keychainaccess",
    ]);
    // Turning strict on later is not refused for apps that were already stored.
    yield* settings.updateSettings({ cuaStrictInputGuards: true });
    expect((yield* settings.getSettings).cuaStrictInputGuards).toBe(true);
  }).pipe(Effect.provide(layerServerSettings().pipe(Layer.provideMerge(NodeServices.layer)))),
);
