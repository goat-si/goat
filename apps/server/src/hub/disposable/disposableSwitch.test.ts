import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DISPOSABLE_NAME_RULE_DEFAULT,
  HubSettings,
  type ServerSettingsPatch,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import { layerServerSettings } from "../../serverSettingsLayers.testkit.ts";
import { disposableSwitch } from "./disposableSwitch.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
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
    expect(on.expiresAt).toBe(new Date(30 * DAY_MS).toISOString());
    const onDisk = JSON.parse(yield* fs.readFileString(config.settingsPath));
    expect(onDisk.hub.attachDisposableMachines.grantId).toBe(on.grantId);

    const seen = new Set([on.grantId]);
    for (const patch of [
      { hub: { attachDisposableMachines: { cap: 3 } } },
      { hub: { attachDisposableMachines: { nameRule: "^cc-[0-9]+$" } } },
      { hub: { attachDisposableMachines: { provisioners: ["thread-a" as never] } } },
      { hub: { attachDisposableMachines: { expiresAt: new Date(5 * DAY_MS).toISOString() } } },
      { hub: { enabled: false } },
      { hub: { enabled: true } },
    ] satisfies ReadonlyArray<ServerSettingsPatch>) {
      const next = yield* grantOf(patch);
      expect(seen.has(next.grantId), JSON.stringify(patch)).toBe(false);
      seen.add(next.grantId);
    }
    const before = (yield* service.getSettings).hub.attachDisposableMachines.grantId;
    expect((yield* grantOf({ hub: { cloudHolder: "auto" } })).grantId).toBe(before);
    expect((yield* grantOf({ defaultThreadEnvMode: "worktree" })).grantId).toBe(before);
    // A patch cannot name the grant; only the server writes one.
    const forged = { hub: { attachDisposableMachines: { grantId: "chosen" } } };
    expect((yield* grantOf(forged as ServerSettingsPatch)).grantId).toBe(before);
  }).pipe(Effect.provide(layerServerSettings().pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("the switch admits work only while on, unexpired and holding its grant", () =>
  Effect.gen(function* () {
    const base = yield* decodeHub({
      enabled: true,
      attachDisposableMachines: {
        enabled: true,
        expiresAt: new Date(10 * DAY_MS).toISOString(),
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
