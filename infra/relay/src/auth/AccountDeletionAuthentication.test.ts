import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { requireFreshMfa } from "./AccountDeletionAuthentication.ts";

it.effect(
  "requires both signed factor ages within 600 seconds including token transit and minute rounding",
  () =>
    Effect.gen(function* () {
      yield* requireFreshMfa({ iat: 1000, fva: [0, 0] }, 1539);
      expect((yield* Effect.flip(requireFreshMfa({ iat: 1000, fva: [0, 0] }, 1540))).reason).toBe(
        "reauthentication_required",
      );
      for (const fva of [
        undefined,
        [0, -1],
        [0],
        [0, 0, 0],
        [0.5, 0],
        [0, Number.MAX_SAFE_INTEGER],
        "0,0",
      ])
        expect((yield* Effect.flip(requireFreshMfa({ iat: 1000, fva }, 1000))).code).toBe(
          "authentication_strength_required",
        );
      expect((yield* Effect.flip(requireFreshMfa({ iat: 1000, fva: [10, 0] }, 1000))).reason).toBe(
        "reauthentication_required",
      );
      expect((yield* Effect.flip(requireFreshMfa({ iat: 1001, fva: [0, 0] }, 1000))).reason).toBe(
        "reauthentication_required",
      );
    }),
);
