import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";

import * as ProviderRegistry from "./ProviderRegistry.ts";

it("drops Cursor models a ready catalog read returns none of", () => {
  const previousProvider = {
    instanceId: ProviderInstanceId.make("cursor"),
    driver: ProviderDriverKind.make("cursor"),
    status: "ready",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    checkedAt: "2026-10-30T00:00:00.000Z",
    version: "1.0.0",
    models: [{ slug: "composer-2", name: "Composer 2", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  } as const satisfies ServerProvider;
  // Cursor reports ready only once its catalog read completes, so an empty one is authoritative.
  const emptied = { ...previousProvider, checkedAt: "2026-10-30T00:01:00.000Z", models: [] };
  const pending = { ...emptied, status: "warning" } satisfies ServerProvider;

  assert.deepStrictEqual(
    ProviderRegistry.mergeProviderSnapshot(previousProvider, emptied).models,
    [],
  );
  assert.deepStrictEqual(ProviderRegistry.mergeProviderSnapshot(previousProvider, pending).models, [
    ...previousProvider.models,
  ]);
});
