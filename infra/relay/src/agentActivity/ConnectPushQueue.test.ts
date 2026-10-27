import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ConnectPushQueue from "./ConnectPushQueue.ts";

it.effect.each(["apns", "fcm"] as const)(
  "retained %s jobs drain with zero provider delivery in the reachability beta",
  () =>
    Effect.gen(function* () {
      let consumed = 0;
      let delivered = 0;
      const retained = Stream.make({ signedJob: "retained-1" }, { signedJob: "retained-2" }).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            consumed++;
          }),
        ),
      );
      yield* ConnectPushQueue.consume(retained, () =>
        Effect.sync(() => {
          delivered++;
        }),
      );
      expect(consumed).toBe(2);
      expect(delivered).toBe(0);
    }),
);
