// @effect-diagnostics preferSchemaOverJson:off -- The fixture speaks MCP JSON-RPC lines.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { active, call, harness } from "./ComputerUseLeaseProxy.testkit.ts";

describe("a call's reservation labels its app for the timeline", () => {
  it.effect("names the app a call's pid runs in its reservation, as the driver named it", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      yield* h.applied;
      yield* h.send(call(1, "list_windows"));
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* h.reply(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            structuredContent: {
              windows: [
                {
                  pid: 42,
                  window_id: 3,
                  app_name: "Calculator",
                  bundle_id: "com.apple.calculator",
                  title: "Calculator",
                },
              ],
            },
          },
        }),
      );
      assert.equal((yield* h.nextToProvider).id, 1);
      yield* h.send(call(2, "click", { pid: 42, window_id: 3, element_index: 5 }));
      const lookup = yield* h.nextToDriver;
      assert.deepEqual(lookup.params, { name: "list_apps", arguments: {} });
      yield* h.reply(
        JSON.stringify({
          jsonrpc: "2.0",
          id: lookup.id,
          result: {
            structuredContent: {
              apps: [
                { pid: 42, bundle_id: "com.apple.calculator", name: "Calculator" },
                { pid: 77, bundle_id: "com.example.Other", name: "Other" },
              ],
            },
          },
        }),
      );
      assert.equal((yield* h.nextToDriver).id, 2);
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }));
      assert.equal((yield* h.nextToProvider).id, 2);
      yield* h.send(call(3, "click", { pid: 77, window_id: 1, element_index: 1 }));
      assert.equal((yield* h.nextToDriver).id, 3);

      const reserved = h.reservations.flatMap((reservation) =>
        reservation.action === "reserve" ? [reservation] : [],
      );
      const labelOf = (pid: number) =>
        reserved.find((reservation) => (reservation.args as { readonly pid?: unknown }).pid === pid)
          ?.appLabel;
      assert.deepEqual(
        reserved.map((reservation) => reservation.name),
        ["list_windows", "click", "click"],
      );
      assert.deepEqual(labelOf(42), { bundleId: "com.apple.calculator", name: "Calculator" });
      assert.deepEqual(labelOf(77), { bundleId: "com.example.Other", name: "Other" });
    }),
  );
});
