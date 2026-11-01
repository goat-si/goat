import { assert, it } from "@effect/vitest";
import { ThreadId, EnvironmentId, ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Admission from "./ProviderOrchestrationAdapterInfrastructure.ts";

const config = {
  threadId: ThreadId.make("fixture-memory-admission"),
  providerSessionId: "fixture-session",
  endpoint: "http://fixture.invalid/mcp",
  environmentId: EnvironmentId.make("fixture"),
  providerInstanceId: ProviderInstanceId.make("fixture"),
  authorizationHeader: "Bearer fixture-only",
  browserToolsAvailable: false,
  grantedScopes: ["memory:read", "memory:write", "orchestration:read"] as const,
};

it.effect("withholds an unattached config and bounds each read to current memory authority", () =>
  Effect.gen(function* () {
    const admission = yield* Admission.ProviderMemoryAdmission;
    assert.isUndefined(yield* admission.fence(config));
    let attached = true;
    let grant: "none" | "read" | "read_write" = "read_write";
    yield* admission.bind(
      () => Effect.sync(() => ({ grant, policyEpoch: 1 })),
      () => Effect.sync(() => attached),
    );
    assert.deepEqual((yield* admission.fence(config))?.grantedScopes, config.grantedScopes);
    grant = "none";
    assert.deepEqual((yield* admission.fence(config))?.grantedScopes, ["orchestration:read"]);
    grant = "read";
    assert.deepEqual((yield* admission.fence(config))?.grantedScopes, [
      "memory:read",
      "orchestration:read",
    ]);
    attached = false;
    assert.isUndefined(yield* admission.fence(config));
  }).pipe(Effect.provide(Admission.layerMemoryAdmission)),
);

it.effect(
  "withholds the old config when credential attachment changes during the authority read",
  () =>
    Effect.gen(function* () {
      const admission = yield* Admission.ProviderMemoryAdmission;
      let attached = true;
      yield* admission.bind(
        () =>
          Effect.sync(() => {
            attached = false;
            return { grant: "read_write" as const, policyEpoch: 2 };
          }),
        () => Effect.sync(() => attached),
      );
      assert.isUndefined(yield* admission.fence(config));
    }).pipe(Effect.provide(Admission.layerMemoryAdmission)),
);
