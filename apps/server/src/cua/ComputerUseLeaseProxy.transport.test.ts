// @effect-diagnostics preferSchemaOverJson:off -- The fixture speaks MCP JSON-RPC lines.
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { active, call, CONTROL, harness } from "./ComputerUseLeaseProxy.testkit.ts";

const detail = (answer: { result?: unknown }) =>
  (answer.result as { structuredContent?: { detail?: unknown } } | undefined)?.structuredContent
    ?.detail;

describe("the proxy's own checks while the lease stream reconnects", () => {
  it.effect("a call waiting on its display check sends no list_windows once the stream drops", () =>
    Effect.gen(function* () {
      let held = false;
      const gate = yield* Deferred.make<void>();
      const h = yield* harness({
        elsewhere: new Set([900]),
        placementGate: gate,
        transportHeld: () => held,
      });
      yield* h.push(active());
      yield* h.send(call(1, "click", { pid: 10, window_id: 20, x: 1, y: 1 }));
      yield* h.checking;
      held = true;
      yield* Deferred.succeed(gate, undefined);
      const answer = yield* h.nextToProvider;
      assert.equal(answer.id, 1);
      assert.equal(detail(answer), "reconnecting");
      assert.equal(yield* h.driverQueued, 0);
    }),
  );

  it.effect("an app lookup answered after the stream drops teaches the agent nothing", () =>
    Effect.gen(function* () {
      let held = false;
      const h = yield* harness({ transportHeld: () => held });
      yield* h.push(active(undefined, ["com.apple.calculator"]));
      yield* h.send(call(1, "click", { target: { kind: "window", pid: 7, window_id: 3 } }));
      const lookup = yield* h.nextToDriver;
      assert.deepEqual(lookup.params, { name: "list_apps", arguments: {} });
      held = true;
      yield* h.reply(
        JSON.stringify({
          jsonrpc: "2.0",
          id: lookup.id,
          result: {
            structuredContent: { apps: [{ pid: 7, bundle_id: "com.secret.app", name: "Secret" }] },
          },
        }),
      );
      const answer = yield* h.nextToProvider;
      assert.equal(answer.id, 1);
      assert.equal(detail(answer), "reconnecting");
      assert.notInclude(JSON.stringify(answer), "com.secret.app");
    }),
  );

  it.effect(
    "a window reply that arrives while the stream reconnects is withheld for the cut-off",
    () =>
      Effect.gen(function* () {
        let held = false;
        const h = yield* harness({ transportHeld: () => held });
        yield* h.push(active());
        yield* h.send(call(1, "get_window_state", { pid: 4, window_id: 9 }));
        yield* h.nextToDriver;
        held = true;
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: "PRIVATE-WINDOW-CONTENT" }] },
          }),
        );
        // A pause ends what is still outstanding; the withheld reply never goes out.
        yield* h.push({ state: "paused", controlId: CONTROL, reason: "private" });
        const answer = yield* h.nextToProvider;
        assert.equal(answer.id, 1);
        assert.notInclude(JSON.stringify(answer), "PRIVATE-WINDOW-CONTENT");
      }),
  );

  it.effect("a safe read's display proof sends no list_windows while the stream reconnects", () =>
    Effect.gen(function* () {
      const h = yield* harness({ elsewhere: new Set([900]), transportHeld: () => true });
      yield* h.push(active());
      yield* h.send(call(1, "health_report"));
      const answer = yield* h.nextToProvider;
      assert.equal(answer.id, 1);
      assert.equal(detail(answer), "reconnecting");
      assert.equal(yield* h.driverQueued, 0);
    }),
  );
});
