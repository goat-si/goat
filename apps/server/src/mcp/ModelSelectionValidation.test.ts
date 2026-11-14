import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { checkModelSelection } from "./ModelSelectionValidation.ts";
import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";

it.effect("accepts an advertised alias and rejects invalid options for that model", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("provider");
    const providers = [
      {
        instanceId,
        models: [
          {
            slug: "model",
            aliases: ["alias"],
            capabilities: { optionDescriptors: [{ id: "fast", label: "Fast", type: "boolean" }] },
          },
        ],
      },
    ];
    const registry = {
      getProviders: Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
    } as unknown as ProviderRegistry.ProviderRegistry["Service"];
    yield* checkModelSelection(registry, { instanceId, model: "Alias" }, true);
    const error = yield* checkModelSelection(
      registry,
      { instanceId, model: "Alias", options: [{ id: "bogus", value: "x" }] },
      true,
    ).pipe(Effect.flip);
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain("Unknown option bogus");
  }),
);
