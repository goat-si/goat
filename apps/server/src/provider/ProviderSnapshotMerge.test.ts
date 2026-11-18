import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

it("does not bring back models the installed CLI is too old to run", () => {
  const pendingProvider = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    status: "warning",
    enabled: true,
    installed: false,
    auth: { status: "unknown" },
    checkedAt: "2026-04-14T00:00:00.000Z",
    version: null,
    models: [
      { slug: "claude-old", name: "Old", isCustom: false, capabilities: null },
      { slug: "claude-next", name: "Next", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  } as const satisfies ServerProvider;
  const probedProvider = {
    ...pendingProvider,
    status: "ready",
    installed: true,
    auth: { status: "authenticated" },
    version: "1.0.0",
    models: [pendingProvider.models[0]],
    updateRequiredModels: [{ slug: "claude-next", name: "Next", minVersion: "1.1.0" }],
  } satisfies ServerProvider;

  assert.deepStrictEqual(
    ProviderRegistry.mergeProviderSnapshot(pendingProvider, probedProvider).models,
    [...probedProvider.models],
  );
});
