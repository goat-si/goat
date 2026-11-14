import { assert } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { ServerSettingsService } from "./serverSettings.ts";

export const assertPrototypeNamedInstances = Effect.fn("assertPrototypeNamedInstances")(function* (
  serverSettings: ServerSettingsService["Service"],
  concurrentId: ProviderInstanceId,
) {
  assert.isTrue(
    ["First", "Second"].includes(
      (yield* serverSettings.getSettings).providerInstances[concurrentId]?.displayName ?? "",
    ),
  );
  for (const name of ["constructor", "toString", "valueOf"]) {
    const instanceId = ProviderInstanceId.make(name);
    const created = yield* serverSettings.updateProviderInstance({
      operation: "create",
      instanceId,
      instance: { driver: ProviderDriverKind.make("codex") },
    });
    assert.isTrue(Object.hasOwn(created.providerInstances, instanceId));
  }
});
