// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import * as Routes from "./CodexRouteService.ts";
import * as RouteFixture from "./CodexRouteService.testkit.ts";
import * as Settings from "../serverSettings.ts";
import * as Mutator from "./ProviderInstanceRegistryMutator.ts";
import {
  DEV_REPLAY_INSTANCE_ID,
  layerSettingsWatcher,
  reconcileSnapshot,
  seedDevReplayInstance,
} from "./ProviderInstanceRegistryHydration.ts";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
  type ServerSettings,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const projectId = ProjectId.make("project-a");
const instanceId = ProviderInstanceId.make("codex_work");
const devUrl = new URL("http://localhost:5733");

type SettingsHome = "checkout" | "elsewhere" | "linked out of the checkout";

/**
 * Runs the seed against a temporary checkout and a temporary "live" home beside it, with the
 * server's settings file in the checkout, in the live home, or behind a checkout junction to it.
 */
const asDevServer = <A, E, R>(
  seed: (checkoutRoot: string) => Effect.Effect<A, E, R>,
  url: URL | undefined,
  home: SettingsHome,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-dev-replay-home-" });
      const checkout = path.join(root, "checkout");
      const live = path.join(root, "live");
      yield* fs.makeDirectory(path.join(live, "dev"), { recursive: true });
      yield* fs.makeDirectory(checkout, { recursive: true });
      if (home === "checkout") {
        yield* fs.makeDirectory(path.join(checkout, ".goat", "dev"), { recursive: true });
      }
      if (home === "linked out of the checkout") {
        // A junction needs no elevation on Windows; POSIX ignores the type.
        yield* Effect.sync(() =>
          NodeFS.symlinkSync(live, path.join(checkout, ".goat"), "junction"),
        );
      }
      const settingsHome = home === "elsewhere" ? live : path.join(checkout, ".goat");
      const settingsPath = path.join(settingsHome, "dev", "settings.json");
      return yield* seed(checkout).pipe(
        Effect.provideService(ServerConfig.ServerConfig, { ...config, devUrl: url, settingsPath }),
      );
    }),
  );

describe("seedDevReplayInstance", () => {
  const seeded = (url: URL | undefined, home: SettingsHome) =>
    Effect.gen(function* () {
      yield* asDevServer(seedDevReplayInstance, url, home);
      const settings = yield* Settings.ServerSettingsService;
      return (yield* settings.getSettings).providerInstances[DEV_REPLAY_INSTANCE_ID];
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "goat-dev-replay-seed-" }),
          Settings.ServerSettingsService.layerTest({
            providerInstances: {
              [DEV_REPLAY_INSTANCE_ID]: {
                driver: ProviderDriverKind.make("acpRegistry"),
                displayName: "My replay",
                enabled: false,
                config: { source: "local", commandPath: "/old/node" },
              },
            },
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );

  effectIt.effect("leaves settings alone outside dev", () =>
    seeded(undefined, "checkout").pipe(
      Effect.map((instance) =>
        expect(instance?.config).toEqual({ source: "local", commandPath: "/old/node" }),
      ),
    ),
  );

  effectIt.effect(
    "never seeds settings stored outside this checkout, such as a live GOAT home",
    () =>
      seeded(devUrl, "elsewhere").pipe(
        Effect.map((instance) =>
          expect(instance?.config).toEqual({ source: "local", commandPath: "/old/node" }),
        ),
      ),
  );

  effectIt.effect("never seeds through a checkout link that resolves to a live GOAT home", () =>
    seeded(devUrl, "linked out of the checkout").pipe(
      Effect.map((instance) =>
        expect(instance?.config).toEqual({ source: "local", commandPath: "/old/node" }),
      ),
    ),
  );

  effectIt.effect("points a dev worktree at the replay agent and keeps user edits", () =>
    seeded(devUrl, "checkout").pipe(
      Effect.map((instance) => {
        expect(instance?.displayName).toBe("My replay");
        expect(instance?.enabled).toBe(false);
        expect(instance?.config).toMatchObject({
          source: "local",
          commandArgs: [expect.stringMatching(/scripts[/\\]dev-replay-agent\.ts$/)],
        });
      }),
    ),
  );

  effectIt.effect("completes once the hydration watcher has reconciled the seeded instance", () =>
    Effect.gen(function* () {
      const reconciled = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        yield* settings.start;
        yield* asDevServer(seedDevReplayInstance, devUrl, "checkout");
        expect(yield* Deferred.isDone(reconciled)).toBe(true);
        expect(
          (yield* settings.getSettings).providerInstances[DEV_REPLAY_INSTANCE_ID]?.driver,
        ).toBe("acpRegistry");
      }).pipe(
        Effect.provide(
          layerSettingsWatcher.pipe(
            Layer.provide(
              Layer.succeed(Mutator.ProviderInstanceRegistryMutator, {
                reconcile: (config) =>
                  config[DEV_REPLAY_INSTANCE_ID]
                    ? Deferred.succeed(reconciled, undefined).pipe(Effect.asVoid)
                    : Effect.void,
              }),
            ),
            // The watcher runs on the same dev server as the seed.
            Layer.provide(
              Layer.effect(
                ServerConfig.ServerConfig,
                Effect.gen(function* () {
                  return { ...(yield* ServerConfig.ServerConfig), devUrl };
                }),
              ),
            ),
            Layer.provideMerge(RouteFixture.layer),
          ),
        ),
      );
    }),
  );
});

function settingsWith(overrides: Partial<ServerSettings>): ServerSettings {
  return { ...DEFAULT_SERVER_SETTINGS, ...overrides };
}

describe("dev replay hydration", () => {
  // What a dev server persisted into an explicit in-checkout home before a non-dev restart.
  const persisted = () =>
    deriveProviderInstanceConfigMap(
      settingsWith({
        providerInstances: {
          [DEV_REPLAY_INSTANCE_ID]: {
            driver: ProviderDriverKind.make("acpRegistry"),
            config: {
              source: "local",
              commandPath: "node",
              commandArgs: ["/checkout/apps/server/scripts/dev-replay-agent.ts"],
            },
          },
        },
      }),
    );
  const hydrated = (url: URL | undefined) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const seen: Array<ProviderInstanceConfigMap> = [];
      yield* reconcileSnapshot(
        { reconcile: (configMap) => Effect.sync(() => void seen.push(configMap)) },
        persisted(),
        undefined,
      ).pipe(Effect.provideService(ServerConfig.ServerConfig, { ...config, devUrl: url }));
      return seen[0];
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "goat-dev-replay-hydration-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );

  effectIt.effect("a restart without a dev server never hydrates a persisted replay instance", () =>
    hydrated(undefined).pipe(
      Effect.map((configMap) => {
        expect(configMap?.[DEV_REPLAY_INSTANCE_ID]).toBeUndefined();
        expect(configMap?.[ProviderInstanceId.make("claudeCloud")]).toBeDefined();
      }),
    ),
  );

  effectIt.effect("a dev server hydrates its replay instance", () =>
    hydrated(devUrl).pipe(
      Effect.map((configMap) =>
        expect(configMap?.[DEV_REPLAY_INSTANCE_ID]?.driver).toBe("acpRegistry"),
      ),
    ),
  );
});

describe("deriveProviderInstanceConfigMap", () => {
  it("makes implicit cloud slots follow their siblings", () => {
    const cursor = ProviderInstanceId.make("cursor");
    const cursorCloud = ProviderInstanceId.make("cursorCloud");
    const claudeCloud = ProviderInstanceId.make("claudeCloud");
    const off = deriveProviderInstanceConfigMap(settingsWith({}));
    expect(off[cursorCloud]).toEqual({
      driver: ProviderDriverKind.make("cursorCloud"),
      enabled: false,
    });
    expect(off[claudeCloud]).toEqual({
      driver: ProviderDriverKind.make("claudeCloud"),
      enabled: true,
    });

    const on = deriveProviderInstanceConfigMap(
      settingsWith({
        providerInstances: {
          [cursor]: { driver: ProviderDriverKind.make("cursor"), enabled: true },
        },
      }),
    );
    expect(on[cursorCloud]).toEqual({
      driver: ProviderDriverKind.make("cursorCloud"),
      enabled: true,
    });
    expect(
      deriveProviderInstanceConfigMap(
        settingsWith({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: false,
            },
          },
        }),
      )[claudeCloud]?.enabled,
    ).toBe(false);
  });

  it("omits a cloud default when an explicit custom-id cloud instance exists", () => {
    const custom = ProviderInstanceId.make("cursorCloud_work");
    const merged = deriveProviderInstanceConfigMap(
      settingsWith({
        providerInstances: {
          [custom]: { driver: ProviderDriverKind.make("cursorCloud"), enabled: true },
        },
      }),
    );
    expect(merged[ProviderInstanceId.make("cursorCloud")]).toBeUndefined();
    expect(merged[custom]?.enabled).toBe(true);
  });

  it("preserves an explicit disabled cloud default even with an enabled sibling", () => {
    const cloud = ProviderInstanceId.make("cursorCloud");
    const merged = deriveProviderInstanceConfigMap(
      settingsWith({
        providerInstances: {
          [ProviderInstanceId.make("cursor")]: {
            driver: ProviderDriverKind.make("cursor"),
            enabled: true,
          },
          [cloud]: { driver: ProviderDriverKind.make("cursorCloud"), enabled: false },
        },
      }),
    );
    expect(merged[cloud]).toEqual({
      driver: ProviderDriverKind.make("cursorCloud"),
      enabled: false,
    });
  });

  it("enables Devin Cloud only with an enabled Devin ACP instance", () => {
    const devinCloud = ProviderInstanceId.make("devinCloud");
    const acpInstance = ProviderInstanceId.make("devin_acp");
    const acpDriver = ProviderDriverKind.make("acpRegistry");
    const without = deriveProviderInstanceConfigMap(settingsWith({}));
    expect(without[devinCloud]).toEqual({
      driver: ProviderDriverKind.make("devinCloud"),
      enabled: false,
    });

    const withDisabled = deriveProviderInstanceConfigMap(
      settingsWith({
        providerInstances: {
          [acpInstance]: { driver: acpDriver, enabled: false, config: { agentId: "devin" } },
        },
      }),
    );
    expect(withDisabled[devinCloud]?.enabled).toBe(false);

    const withEnabled = deriveProviderInstanceConfigMap(
      settingsWith({
        providerInstances: {
          [acpInstance]: { driver: acpDriver, enabled: true, config: { agentId: "devin" } },
        },
      }),
    );
    expect(withEnabled[devinCloud]?.enabled).toBe(true);
  });

  it("turns a machine-disabled instance on when a project enables it", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({ driver: ProviderDriverKind.make("codex"), enabled: true });
  });

  it("clears a nested config.enabled:false flag when a project enables the instance", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          config: { enabled: false },
        },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toEqual({
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: { enabled: true },
    });
  });

  it("does not revive an instance a project override references but settings no longer configure", () => {
    const settings = settingsWith({
      providerInstances: {},
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBeUndefined();
  });

  it("ignores a project override that disables an instance, leaving the machine's config in charge", () => {
    const settings = settingsWith({
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    });

    const merged = deriveProviderInstanceConfigMap(settings);

    expect(merged[instanceId]).toBe(settings.providerInstances[instanceId]);
  });
});

effectIt.effect(
  "acknowledges only after reconciliation completes and preserves the committed revision",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        const routes = yield* Routes.CodexRouteService;
        yield* settings.start;
        const mutation = yield* routes
          .mutateProviderInstance(
            {
              mutation: {
                operation: "create",
                instanceId: RouteFixture.instanceId,
                instance: {
                  driver: ProviderDriverKind.make("codex"),
                  displayName: "Hydrated Home",
                  config: { modelRoute: "opencodex" },
                },
              },
            },
            RouteFixture.caller,
          )
          .pipe(
            Effect.tap(() => Deferred.succeed(finished, undefined)),
            Effect.forkScoped,
          );
        yield* Deferred.await(started);
        expect(yield* Deferred.isDone(finished)).toBe(false);
        yield* Deferred.succeed(resume, undefined);
        expect(
          (yield* Fiber.join(mutation)).providerInstances[RouteFixture.instanceId]?.displayName,
        ).toBe("Hydrated Home");
      }).pipe(
        Effect.provide(
          layerSettingsWatcher.pipe(
            Layer.provide(
              Layer.succeed(Mutator.ProviderInstanceRegistryMutator, {
                reconcile: (config) =>
                  config[RouteFixture.instanceId]
                    ? Deferred.succeed(started, undefined).pipe(
                        Effect.andThen(Deferred.await(resume)),
                      )
                    : Effect.void,
              }),
            ),
            Layer.provideMerge(RouteFixture.layer),
          ),
        ),
      );
    }),
);
