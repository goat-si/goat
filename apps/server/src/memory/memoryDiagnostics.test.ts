import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import { checkedPage } from "./memoryDiagnostics.ts";

it.effect(
  "a page that breaks its contract logs the stage, field path and item id, never the text",
  () =>
    Effect.gen(function* () {
      const logs: Array<unknown> = [];
      const memoryId = "00000000-0000-4000-8000-000000000001";
      const text = "synthetic private memory text";
      const key = "synthetic private key text";
      const item = { memoryId, status: "active", payload: { text }, [key]: text };
      const exit = yield* Effect.exit(
        checkedPage({ items: [item], projectionWatermark: 0, nextCursor: null }, [
          item as never,
        ]).pipe(
          Effect.provide(
            Logger.layer([Logger.make(({ message }) => logs.push(message))], {
              mergeWithExisting: false,
            }),
          ),
        ),
      );
      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("invalid_output");
      const logged = JSON.stringify(logs);
      expect(logged).toContain("memory-page");
      expect(logged).toContain("items.0");
      expect(logged).toContain(memoryId);
      expect(logged).not.toContain(text);
      expect(logged).not.toContain(key);
    }),
);
