import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

it("drops Cursor models a completed catalog read no longer returns", () => {
  const previousProvider = {
    instanceId: ProviderInstanceId.make("cursor"),
    driver: ProviderDriverKind.make("cursor"),
    status: "ready",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    checkedAt: "2026-10-30T00:00:00.000Z",
    version: "1.0.0",
    models: [
      { slug: "composer-2", name: "Composer 2", isCustom: false, capabilities: null },
      { slug: "retired-model-x", name: "Retired", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  } as const satisfies ServerProvider;
  const refreshedProvider = {
    ...previousProvider,
    checkedAt: "2026-10-30T00:01:00.000Z",
    models: [previousProvider.models[0]],
  } satisfies ServerProvider;
  const failedProvider = {
    ...refreshedProvider,
    status: "error",
    auth: { status: "unknown" },
    message: "Cursor SDK model discovery timed out.",
  } satisfies ServerProvider;

  assert.deepStrictEqual(
    ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).models,
    [previousProvider.models[0]],
  );
  assert.deepStrictEqual(
    ProviderRegistry.mergeProviderSnapshot(previousProvider, failedProvider).models,
    [...previousProvider.models],
  );
});
