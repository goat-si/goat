import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DISPOSABLE_NAME_RULE_DEFAULT,
  ProviderDriverKind,
  ProviderInstanceId,
  HubSettings,
  type ServerSettingsPatch,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import { layerServerSettings } from "../../serverSettingsLayers.testkit.ts";
import { disposableSwitch } from "./disposableSwitch.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (days: number) => DateTime.formatIso(DateTime.makeUnsafe(days * DAY_MS));
const decodeHub = Schema.decodeUnknownEffect(HubSettings);

it.effect("the switch is off with no provisioners, cap 10 and the default name rule", () =>
  Effect.gen(function* () {
    const hub = yield* decodeHub({});
    expect(hub.attachDisposableMachines).toEqual({
      enabled: false,
      provisioners: [],
      cap: 10,
      nameRule: DISPOSABLE_NAME_RULE_DEFAULT,
      expiresAt: null,
      grantId: null,
    });
    expect(disposableSwitch(hub, 0)).toEqual({ open: false, reason: "switch_off" });
  }),
);

it.effect("every change to the switch writes a new grant to disk; other changes keep it", () =>
  Effect.gen(function* () {
    const service = yield* ServerSettingsModule.ServerSettingsService;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* service.start;
    const grantOf = (patch: ServerSettingsPatch) =>
      service.updateSettings(patch).pipe(Effect.map((s) => s.hub.attachDisposableMachines));

    const on = yield* grantOf({
      hub: { enabled: true, attachDisposableMachines: { enabled: true } },
    });
    expect(on.grantId).toEqual(expect.any(String));
    // The test clock starts at 0, so the default expiry is 30 days after the epoch.
    expect(on.expiresAt).toBe(iso(30));
    const onDisk = JSON.parse(yield* fs.readFileString(config.settingsPath));
    expect(onDisk.hub.attachDisposableMachines.grantId).toBe(on.grantId);

    const seen = new Set([on.grantId]);
    for (const patch of [
      { hub: { attachDisposableMachines: { cap: 3 } } },
      { hub: { attachDisposableMachines: { nameRule: "^cc-[0-9]+$" } } },
      { hub: { attachDisposableMachines: { provisioners: ["thread-a" as never] } } },
      { hub: { attachDisposableMachines: { expiresAt: iso(5) } } },
      { hub: { enabled: false } },
    ] satisfies ReadonlyArray<ServerSettingsPatch>) {
      const next = yield* grantOf(patch);
      expect(seen.has(next.grantId), JSON.stringify(patch)).toBe(false);
      seen.add(next.grantId);
    }
    const before = (yield* service.getSettings).hub.attachDisposableMachines.grantId;
    // Turning the hub off turned the switch off; with it off, a consent change grants nothing.
    expect((yield* grantOf({ hub: { enabled: true } })).grantId).toBe(before);
    expect((yield* grantOf({ hub: { attachDisposableMachines: { cap: 4 } } })).grantId).toBe(
      before,
    );
    expect((yield* grantOf({ hub: { cloudHolder: "auto" } })).grantId).toBe(before);
    expect((yield* grantOf({ defaultThreadEnvMode: "worktree" })).grantId).toBe(before);
    // A patch cannot name the grant; only the server writes one.
    const forged = { hub: { attachDisposableMachines: { grantId: "chosen" } } };
    expect((yield* grantOf(forged as ServerSettingsPatch)).grantId).toBe(before);
  }).pipe(Effect.provide(layerServerSettings().pipe(Layer.provideMerge(NodeServices.layer)))),
);

// A provider change carries any settings patch; it must end a grant like any other write.
it.effect("turning the hub off and on through provider changes still ends the old grant", () =>
  Effect.gen(function* () {
    const service = yield* ServerSettingsModule.ServerSettingsService;
    yield* service.start;
    const grant = service.getSettings.pipe(
      Effect.map((settings) => settings.hub.attachDisposableMachines.grantId),
    );
    yield* service.updateSettings({
      hub: { enabled: true, attachDisposableMachines: { enabled: true } },
    });
    const before = yield* grant;
    const instanceId = ProviderInstanceId.make("kilo-disposable");
    const upsert = (displayName: string) =>
      ({
        operation: "upsert",
        instanceId,
        instance: {
          driver: ProviderDriverKind.make("acpRegistry"),
          displayName,
          config: { agentId: "kilo", distribution: "auto" },
        },
      }) as const;
    yield* service.updateProviderInstance(upsert("Kilo"), { hub: { enabled: false } });
    yield* service.updateProviderInstance(upsert("Kilo 2"), { hub: { enabled: true } });
    expect(yield* grant).not.toBe(before);
  }).pipe(Effect.provide(layerServerSettings().pipe(Layer.provideMerge(NodeServices.layer)))),
);

// hub.enabled is not the person's switch: any write that turns the hub off and on must not renew it.
it.effect("an expired switch stays closed when any write turns the hub off and on", () =>
  Effect.gen(function* () {
    const service = yield* ServerSettingsModule.ServerSettingsService;
    yield* service.start;
    yield* service.updateSettings({
      hub: { enabled: true, attachDisposableMachines: { enabled: true } },
    });
    yield* TestClock.adjust(31 * DAY_MS);
    const instanceId = ProviderInstanceId.make("kilo-disposable");
    const upsert = {
      operation: "upsert",
      instanceId,
      instance: {
        driver: ProviderDriverKind.make("acpRegistry"),
        displayName: "Kilo",
        config: { agentId: "kilo", distribution: "auto" },
      },
    } as const;
    const closed = Effect.gen(function* () {
      const hub = (yield* service.getSettings).hub;
      expect(disposableSwitch(hub, 31 * DAY_MS).open).toBe(false);
      expect(hub.attachDisposableMachines.expiresAt).toBe(iso(30));
    });
    yield* service.updateSettings({ hub: { enabled: false } });
    yield* service.updateSettings({ hub: { enabled: true } });
    yield* closed;
    yield* service.updateProviderInstance(upsert, { hub: { enabled: false } });
    yield* service.updateProviderInstance(upsert, { hub: { enabled: true } });
    yield* closed;
    // Turning the hub off turns the switch off, so only a person opens it again.
    expect((yield* service.getSettings).hub.attachDisposableMachines.enabled).toBe(false);
  }).pipe(Effect.provide(layerServerSettings().pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("a person's past expiry keeps the switch closed, and a far one is held to 30 days", () =>
  Effect.gen(function* () {
    const service = yield* ServerSettingsModule.ServerSettingsService;
    yield* service.start;
    yield* TestClock.adjust(5 * DAY_MS);
    const value = service.getSettings.pipe(
      Effect.map((settings) => settings.hub.attachDisposableMachines),
    );
    yield* service.updateSettings({
      hub: { enabled: true, attachDisposableMachines: { enabled: true, expiresAt: iso(2) } },
    });
    expect((yield* value).expiresAt).toBe(iso(2));
    expect(disposableSwitch((yield* service.getSettings).hub, 5 * DAY_MS)).toEqual({
      open: false,
      reason: "switch_expired",
    });
    yield* service.updateSettings({ hub: { attachDisposableMachines: { cap: 3 } } });
    expect((yield* value).expiresAt).toBe(iso(2));
    yield* service.updateSettings({ hub: { attachDisposableMachines: { expiresAt: iso(400) } } });
    expect((yield* value).expiresAt).toBe(iso(35));
    // Turning the switch off and on again gives it a new 30 days.
    yield* service.updateSettings({ hub: { attachDisposableMachines: { enabled: false } } });
    yield* TestClock.adjust(DAY_MS);
    yield* service.updateSettings({ hub: { attachDisposableMachines: { enabled: true } } });
    expect((yield* value).expiresAt).toBe(iso(36));
  }).pipe(Effect.provide(layerServerSettings().pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("the switch admits work only while on, unexpired and holding its grant", () =>
  Effect.gen(function* () {
    const base = yield* decodeHub({
      enabled: true,
      attachDisposableMachines: {
        enabled: true,
        expiresAt: iso(10),
        grantId: "g1",
      },
    });
    const open = disposableSwitch(base, DAY_MS);
    expect(open).toEqual({ open: true, grant: expect.stringMatching(/^g1:/u) });
    expect(disposableSwitch(base, 10 * DAY_MS)).toEqual({ open: false, reason: "switch_expired" });
    expect(disposableSwitch({ ...base, enabled: false }, DAY_MS)).toEqual({
      open: false,
      reason: "switch_off",
    });
    const noGrant = {
      ...base,
      attachDisposableMachines: { ...base.attachDisposableMachines, grantId: null },
    };
    expect(disposableSwitch(noGrant, DAY_MS)).toEqual({ open: false, reason: "switch_off" });
    // A hand edit of the settings file keeps the grantId but still ends the grant.
    const edited = {
      ...base,
      attachDisposableMachines: { ...base.attachDisposableMachines, cap: 50 },
    };
    const reopened = disposableSwitch(edited, DAY_MS);
    expect(reopened.open && open.open && reopened.grant !== open.grant).toBe(true);
  }),
);
