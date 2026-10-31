import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { active, call, harness } from "./ComputerUseLeaseProxy.testkit.ts";
import { deniedCallApp } from "./ComputerUseCallSafety.ts";

describe("ComputerUseLeaseProxy identity safety", () => {
  it.effect.each([true, false])(
    "never forwards an uncached content read when the target is denied or unresolved (%s)",
    (found) =>
      Effect.gen(function* () {
        const h = yield* harness({
          reservation: (request) =>
            Effect.sync(() => {
              if (request.action !== "reserve") return { status: "released" } as const;
              const app = deniedCallApp(request, ["com.example.Blocked"]);
              return app === undefined
                ? ({ status: "admitted", reservationId: null } as const)
                : ({ status: "refused", detail: "app_not_allowed", app } as const);
            }),
        });
        yield* h.push(active());
        yield* h.applied;
        yield* h.send(call(1, "get_window_state", { pid: 42, window_id: 7 }));
        const lookup = yield* h.nextToDriver;
        assert.deepEqual(lookup.params, { name: "list_apps", arguments: {} });
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: lookup.id,
            result: {
              structuredContent: {
                apps: found ? [{ pid: 42, bundle_id: "com.example.Blocked", name: "Blocked" }] : [],
              },
            },
          }),
        );
        const answer = yield* h.nextToProvider;
        assert.include(JSON.stringify(answer), "app_not_allowed");
        assert.equal(yield* h.driverQueued, 0);
      }),
  );
  it.effect("reuses a listed identity until the target disappears or the turn changes", () =>
    Effect.gen(function* () {
      const h = yield* harness({ autoAppListing: false });
      yield* h.push({ ...active(), identityEpoch: 0 });
      yield* h.applied;
      const resolve = Effect.fn(function* () {
        const lookup = yield* h.nextToDriver;
        assert.deepEqual(lookup.params, { name: "list_apps", arguments: {} });
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: lookup.id,
            result: {
              structuredContent: {
                apps: [{ pid: 4, bundle_id: "com.example.Editor", name: "Editor" }],
              },
            },
          }),
        );
      });
      yield* h.send(call(1, "click", { pid: 4, window_id: 9 }));
      yield* resolve();
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* h.reply(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { structuredContent: { pid: 4, app_name: "Editor" } },
        }),
      );
      yield* h.nextToProvider;
      yield* h.send(call(2, "click", { pid: 4, window_id: 9 }));
      assert.equal((yield* h.nextToDriver).id, 2);
      yield* h.reply(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { isError: true, structuredContent: { code: "process_not_found" } },
        }),
      );
      yield* h.nextToProvider;
      yield* h.send(call(3, "click", { pid: 4, window_id: 9 }));
      yield* resolve();
      assert.equal((yield* h.nextToDriver).id, 3);
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [] } }));
      yield* h.nextToProvider;
      yield* h.push({ ...active(), identityEpoch: 1 });
      yield* h.applied;
      yield* h.send(call(4, "click", { pid: 4, window_id: 9 }));
      yield* resolve();
      assert.equal((yield* h.nextToDriver).id, 4);
    }),
  );
  it.effect(
    "lets a thread act only on its approved apps, asking the driver which app a pid is",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ autoAppListing: false });
        yield* h.push(active(undefined, ["com.apple.calculator"]));
        yield* h.send(call(1, "click", { target: { kind: "window", pid: 42, window_id: 1 } }));
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
                  { pid: 7, bundle_id: "com.apple.Terminal", name: "Terminal" },
                ],
              },
            },
          }),
        );
        assert.equal((yield* h.nextToDriver).id, 1);

        yield* h.send(
          call(2, "type_text", {
            text: "rm -rf ~",
            target: { kind: "window", pid: 7, window_id: 3 },
          }),
        );
        const refused = yield* h.nextToProvider;
        assert.deepInclude(
          (refused.result as Record<string, unknown>).structuredContent as object,
          {
            refused: "appNotAllowed",
            app: "com.apple.Terminal",
          },
        );
        for (const [id, name, args] of [
          [4, "press_key", { key: "return" }],
          [5, "run_script", { script: "click()" }],
        ] as const) {
          yield* h.send(call(id, name, args));
          const answer = yield* h.nextToProvider;
          assert.equal(answer.id, id);
          assert.deepInclude(
            (answer.result as Record<string, unknown>).structuredContent as object,
            {
              refused: "appNotAllowed",
              detail: "app_not_allowed",
            },
          );
        }
        // Listing what is on screen touches no app.
        yield* h.send(call(6, "list_windows"));
        assert.equal((yield* h.nextToDriver).id, 6);
        assert.equal(yield* h.driverQueued, 0);
      }),
  );
});
