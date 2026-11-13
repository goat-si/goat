import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Gateway from "../../pen/PenGateway.ts";
import { closePenRoute, openPenRoute } from "./penRoute.ts";

it.effect("routes invoke the main-owned gateway with the exact pin", () =>
  Effect.gen(function* () {
    const pin = { meshId: "m".repeat(26), nodeId: "a".repeat(26), noisePub: "a".repeat(43) };
    const calls: unknown[] = [];
    const result = { kind: "refused", reason: "unavailable" } as const;
    const service = {
      open: async (value: typeof pin) => {
        calls.push(value);
        return result;
      },
      close: async (value: typeof pin) => {
        calls.push(value);
      },
      dispose: async () => {},
    };
    yield* Effect.gen(function* () {
      assert.deepEqual(yield* openPenRoute.handler(pin), result);
      yield* closePenRoute.handler(pin);
    }).pipe(Effect.provideService(Gateway.PenGateway, service));
    assert.deepEqual(calls, [pin, pin]);
  }),
);
