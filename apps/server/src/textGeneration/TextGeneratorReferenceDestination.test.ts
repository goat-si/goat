import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId, SecretProviderId } from "@goat/contracts";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

vi.mock("../secrets/secretResolver.ts", () => ({
  cachedResolveSecret: async () => "fixture-secret",
}));
import * as TextGeneration from "./TextGeneration.ts";

it.effect("uses an existing saved reference only at its saved model API address", () =>
  Effect.gen(function* () {
    const id = ProviderInstanceId.make("api");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerators: {
        [id]: {
          kind: "openaiCompatible" as const,
          baseUrl: "https://saved.example/v1",
          apiKey: { provider: SecretProviderId.make("vault"), reference: "op://vault/item/field" },
          enabled: true,
        },
      },
    };
    using fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: '{"title":"Done"}' } }],
      }),
    );
    const generation = yield* TextGeneration.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: () => Effect.die("unused"),
          }),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("unused"),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(settings),
          }),
        ),
      ),
    );
    expect(
      yield* generation.generateThreadTitle({
        cwd: "/unused",
        message: "work",
        linkedContext: "",
        modelSelection: { instanceId: id, model: "small" },
      }),
    ).toEqual({ title: "Done" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://saved.example/v1/chat/completions");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer fixture-secret",
    );
  }),
);
