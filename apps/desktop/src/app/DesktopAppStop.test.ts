import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as DesktopApp from "./DesktopApp.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import { BACKEND_STOP_TIMEOUT } from "../backend/DesktopBackendProcess.ts";

it.effect.each(["quit", "relaunch"] as const)("stops every pool instance for %s", (reason) =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const instance = () =>
      ({
        stop: (stopReason: string, options: unknown) =>
          Effect.sync(() => {
            calls.push([stopReason, options]);
          }),
      }) as DesktopBackendPool.DesktopBackendInstance;
    const pool = Layer.mock(DesktopBackendPool.DesktopBackendPool)({
      list: Effect.succeed([instance(), instance()]),
    });
    yield* Effect.gen(function* () {
      const state = yield* DesktopState.DesktopState;
      if (reason === "relaunch") yield* Ref.set(state.stopReason, reason);
      yield* DesktopApp.stopAllPoolInstances();
    }).pipe(Effect.provide(Layer.merge(pool, DesktopState.layer)));
    assert.deepStrictEqual(calls, [
      [reason, { timeout: BACKEND_STOP_TIMEOUT }],
      [reason, { timeout: BACKEND_STOP_TIMEOUT }],
    ]);
  }),
);
