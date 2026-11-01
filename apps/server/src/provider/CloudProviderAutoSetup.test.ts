import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  isDevinAcpRegistryInstance,
  resolveProjectProviderInstanceEnabled,
  type ServerSettings,
} from "@goat/contracts";
import { SpawnExecutableResolution } from "@goat/shared/shell";
import * as Effect from "effect/Effect";

import * as ServerSettingsModule from "../serverSettings.ts";
import { make, planCloudAutoSetup } from "./CloudProviderAutoSetup.ts";

const cli = { devin: "/home/me/.local/bin/devin", cursorAgent: "/home/me/.local/bin/cursor-agent" };
const none = { devin: undefined, cursorAgent: undefined };
const withInstances = (
  providerInstances: Record<string, { driver: string; enabled?: boolean; config?: unknown }>,
): Pick<ServerSettings, "providerInstances"> =>
  ({ providerInstances }) as unknown as Pick<ServerSettings, "providerInstances">;

describe("planCloudAutoSetup", () => {
  it("sets up Devin and Cursor Cloud from the CLIs on a fresh machine", () => {
    assert.deepEqual(planCloudAutoSetup(withInstances({}), cli), [
      {
        provider: "devinCloud",
        siblingId: ProviderInstanceId.make("acpRegistry_devin"),
        command: cli.devin,
      },
      {
        provider: "cursorCloud",
        siblingId: ProviderInstanceId.make("cursor"),
        command: cli.cursorAgent,
      },
    ]);
    assert.deepEqual(planCloudAutoSetup(withInstances({}), none), []);
  });

  it("never overrides a provider the person configured", () => {
    for (const instances of [
      { mine: { driver: "acpRegistry", enabled: false, config: { agentId: "devin" } } },
      { devinCloud: { driver: "devinCloud", enabled: false } },
      { work: { driver: "cursor", enabled: false } },
      { cursorCloud: { driver: "cursorCloud", enabled: false } },
    ]) {
      const providers = planCloudAutoSetup(withInstances(instances), cli).map(
        (step) => step.provider,
      );
      const touched = Object.values(instances)[0]!.driver;
      assert.notInclude(
        providers,
        touched === "acpRegistry" || touched === "devinCloud" ? "devinCloud" : "cursorCloud",
      );
    }
  });

  it("picks a free id when acpRegistry_devin belongs to another agent", () => {
    const [step] = planCloudAutoSetup(
      withInstances({
        acpRegistry_devin: { driver: "acpRegistry", config: { agentId: "gemini" } },
      }),
      { devin: cli.devin, cursorAgent: undefined },
    );
    assert.equal(step?.siblingId, "acpRegistry_devin_2");
  });
});

describe("CloudProviderAutoSetup.apply", () => {
  it.effect("links a Devin provider, turns both clouds on, and runs only once", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const service = yield* make;
      const done = yield* service.apply;
      assert.deepEqual(
        done.map((step) => step.provider),
        ["devinCloud", "cursorCloud"],
      );
      const after = yield* settings.getSettings;
      const sibling = after.providerInstances[ProviderInstanceId.make("acpRegistry_devin")]!;
      assert.isTrue(isDevinAcpRegistryInstance(sibling));
      assert.deepInclude(sibling.config as object, { commandPath: cli.devin });
      const devinCloud = after.providerInstances[ProviderInstanceId.make("devinCloud")]!;
      assert.deepInclude(devinCloud.config as object, { siblingInstanceId: "acpRegistry_devin" });
      for (const id of ["devinCloud", "cursorCloud"]) {
        assert.isTrue(
          resolveProjectProviderInstanceEnabled(after, null, ProviderInstanceId.make(id)),
          id,
        );
      }

      // Removing what setup created is final: the next refresh does not bring it back.
      yield* settings.updateProviderInstance({
        operation: "remove",
        instanceId: ProviderInstanceId.make("acpRegistry_devin"),
      });
      assert.deepEqual(yield* service.apply, []);
      assert.isUndefined(
        (yield* settings.getSettings).providerInstances[
          ProviderInstanceId.make("acpRegistry_devin")
        ],
      );
      assert.equal(
        (yield* settings.getSettings).providerInstances[ProviderInstanceId.make("devinCloud")]
          ?.driver,
        ProviderDriverKind.make("devinCloud"),
      );
    }).pipe(
      Effect.provideService(SpawnExecutableResolution, (command) =>
        command === "devin" ? cli.devin : command === "cursor-agent" ? cli.cursorAgent : undefined,
      ),
      Effect.provide(ServerSettingsModule.ServerSettingsService.layerTest()),
    ),
  );

  it.effect("leaves settings untouched when no vendor CLI is installed", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const before = yield* settings.getSettings;
      assert.deepEqual(yield* (yield* make).apply, []);
      assert.deepEqual((yield* settings.getSettings).providerInstances, before.providerInstances);
      assert.deepEqual(before.providerInstances, DEFAULT_SERVER_SETTINGS.providerInstances);
    }).pipe(
      Effect.provideService(SpawnExecutableResolution, () => undefined),
      Effect.provide(ServerSettingsModule.ServerSettingsService.layerTest()),
    ),
  );
});
