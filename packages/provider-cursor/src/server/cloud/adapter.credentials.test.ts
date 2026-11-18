import { expect, it } from "@effect/vitest";
import { ProviderSetupError } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { BACKEND_MISMATCH } from "./credentials.ts";
import { instanceId, makeHarness } from "./adapter.testkit.ts";

it.effect(
  "preserves actionable backend mismatch advice without exposing the credential error cause",
  () =>
    Effect.gen(function* () {
      const marker = "synthetic-secret";
      const h = yield* makeHarness(
        Effect.fail(
          new ProviderSetupError({
            instanceId,
            operation: "credentials",
            detail: BACKEND_MISMATCH,
            cause: new Error(marker),
          }),
        ),
      );
      const failure = yield* h.runtime.startTurn(h.input).pipe(Effect.flip);
      expect(failure).toMatchObject({ detail: BACKEND_MISMATCH });
      expect(Cause.pretty(Cause.fail(failure))).not.toContain(marker);
      expect(h.create).not.toHaveBeenCalled();
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
);
