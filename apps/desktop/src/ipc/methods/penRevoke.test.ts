import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PenRevoke from "../../pen/PenRevoke.ts";
import { revokePenMember } from "./penRevoke.ts";

it.effect("forwards the exact pin to the main-owned revoke service", () =>
  Effect.gen(function* () {
    const pin = { meshId: "m".repeat(26), nodeId: "a".repeat(26), noisePub: "a".repeat(43) };
    let received: unknown;
    const result = yield* revokePenMember.handler(pin).pipe(
      Effect.provideService(PenRevoke.PenRevoke, {
        revoke: (value) =>
          Effect.sync(() => {
            received = value;
            return { status: "cancelled" as const };
          }),
      }),
    );
    assert.deepEqual(received, pin);
    assert.deepEqual(result, { status: "cancelled" });
  }),
);
