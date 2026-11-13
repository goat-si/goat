import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerWith, PenGateway } from "./PenGateway.ts";

it.effect("a closed viewer gate provides no gateway, and without one every open is refused", () =>
  Effect.gen(function* () {
    expect(layerWith({ enabled: false })).toBe(Layer.empty);
    const gateway = yield* PenGateway;
    const result = yield* Effect.promise(() =>
      gateway.open({ meshId: "m".repeat(26), nodeId: "a".repeat(26), noisePub: "a".repeat(43) }),
    );
    expect(result).toEqual({ kind: "refused", reason: "unavailable" });
  }),
);
