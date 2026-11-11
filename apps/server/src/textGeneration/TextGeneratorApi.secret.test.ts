import { it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId, SecretProviderId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";

const deferred = vi.hoisted(() => ({
  started: Promise.withResolvers<void>(),
  secret: Promise.withResolvers<string>(),
}));
vi.mock("../secrets/secretResolver.ts", () => ({
  cachedResolveSecret: () => {
    deferred.started.resolve();
    return deferred.secret.promise;
  },
}));
import { apiTextGeneration } from "./TextGeneratorApi.ts";

it.effect("never sends a request after its secret lookup times out", () =>
  Effect.gen(function* () {
    using fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    const service = apiTextGeneration(
      {
        kind: "openaiCompatible",
        baseUrl: "https://model.example/v1",
        enabled: true,
        apiKey: { provider: SecretProviderId.make("vault"), reference: "op://vault/item/key" },
      },
      DEFAULT_SERVER_SETTINGS.secretProviders,
    );
    const pending = yield* service
      .generateThreadTitle({
        cwd: "/unused",
        message: "title",
        linkedContext: "",
        modelSelection: { instanceId: ProviderInstanceId.make("api"), model: "small" },
      })
      .pipe(Effect.flip, Effect.forkChild);
    yield* Effect.promise(() => deferred.started.promise);
    yield* TestClock.adjust("120 seconds");
    yield* Fiber.join(pending);
    deferred.secret.resolve("fixture-secret");
    yield* Effect.promise(() => deferred.secret.promise);
    yield* Effect.promise(() => Promise.resolve());
    expect(fetchMock).not.toHaveBeenCalled();
  }),
);
