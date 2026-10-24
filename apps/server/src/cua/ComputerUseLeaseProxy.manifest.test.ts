import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { active, call, CONTROL, harness } from "./ComputerUseLeaseProxy.testkit.ts";

describe("ComputerUseLeaseProxy manifest refresh (#1416)", () => {
  it.effect(
    "a rewritten manifest gets a fresh driver before the next idle call, never under a running one",
    () =>
      Effect.gen(function* () {
        let manifest = "v1";
        const h = yield* harness({ manifestStamp: () => manifest });
        yield* h.push(active());
        yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
        assert.equal((yield* h.nextToDriver).id, 1);
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
        yield* h.nextToProvider;
        // The desktop added a newly approved app: the old child goes, a new one serves the call.
        manifest = "v2";
        yield* h.send(call(2, "click", { pid: 5, window_id: 3, x: 1, y: 1 }));
        yield* h.killed;
        yield* h.restarted;
        assert.equal((yield* h.nextToDriver).id, 2);
        // With a call still running, a later change waits; both calls reach the same child.
        manifest = "v3";
        yield* h.send(call(3, "click", { pid: 5, window_id: 3, x: 1, y: 1 }));
        assert.equal((yield* h.nextToDriver).id, 3);
        assert.equal(yield* h.providerQueued, 0);
      }),
  );

  it.effect(
    "a pause and resume while a refresh stops the old child leave one child, and the call is refused",
    () =>
      Effect.gen(function* () {
        let manifest = "v1";
        const gate = yield* Deferred.make<void>();
        const h = yield* harness({ manifestStamp: () => manifest, firstKillGate: gate });
        yield* h.push(active());
        manifest = "v2";
        const forwarded = yield* h
          .send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }))
          .pipe(Effect.forkChild);
        assert.equal(yield* h.taken, "active");
        assert.equal(yield* h.applied, "active");
        // The refresh is stopping the first child; the person takes the screen and hands it back.
        yield* h.killed;
        yield* h.push({ state: "paused", controlId: CONTROL, reason: "human_input" });
        // The proxy has the pause, but waits for the refresh to finish before acting on it.
        assert.equal(yield* h.taken, "paused");
        assert.equal(yield* h.appliedQueued, 0);
        yield* h.push(active());
        yield* Deferred.succeed(gate, undefined);
        assert.equal(yield* h.applied, "paused");
        yield* Fiber.join(forwarded);
        const answer = yield* h.nextToProvider;
        assert.deepInclude((answer.result as Record<string, unknown>).structuredContent as object, {
          detail: "waiting_for_human",
        });
        // The refresh's child, then the resume's: each replaced in turn, never two at once.
        yield* h.restarted;
        yield* h.restarted;
        assert.equal(yield* h.startedQueued, 0);
        assert.equal(yield* h.liveDrivers, 1);
        // Refused before any child heard it, never sent and then cancelled.
        assert.notInclude(h.log, "send click");
      }),
  );

  it.effect.each([
    ["right after the refresh began", []],
    ["behind an unchanged approval", [["com.example.a", "com.example.b"]]],
    ["behind a widened approval", [["com.example.a", "com.example.b", "com.example.c"]]],
  ] as const)(
    "an approval narrowed %s while a refresh stops the old child refuses a call for the revoked app",
    ([, before]) =>
      Effect.gen(function* () {
        let manifest = "v1";
        const gate = yield* Deferred.make<void>();
        const h = yield* harness({ manifestStamp: () => manifest, firstKillGate: gate });
        yield* h.push(active(undefined, ["com.example.a", "com.example.b"]));
        assert.equal(yield* h.taken, "active");
        assert.equal(yield* h.applied, "active");
        // The proxy learns that pid 4 is app A.
        yield* h.send(call(1, "list_apps"));
        assert.equal((yield* h.nextToDriver).id, 1);
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [],
              structuredContent: { apps: [{ pid: 4, bundle_id: "com.example.a", name: "A" }] },
            },
          }),
        );
        yield* h.nextToProvider;
        // A newly approved app rewrote the manifest: the next call waits for a fresh child.
        manifest = "v2";
        const forwarded = yield* h
          .send(call(2, "click", { pid: 4, window_id: 9, x: 1, y: 1 }))
          .pipe(Effect.forkChild);
        yield* h.killed;
        // While the old child stops, updates arrive; the last narrows the approval to app B.
        for (const approved of before) {
          yield* h.push(active(undefined, approved));
          assert.equal(yield* h.taken, "active");
        }
        yield* h.push(active(undefined, ["com.example.b"]));
        assert.equal(yield* h.taken, "active");
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(forwarded);
        const answer = yield* h.nextToProvider;
        assert.equal(answer.id, 2);
        assert.deepInclude((answer.result as Record<string, unknown>).structuredContent as object, {
          detail: "app_not_approved",
        });
        assert.notProperty(
          (answer.result as Record<string, unknown>).structuredContent as object,
          "effect",
        );
        // App A's click never reached any driver.
        assert.notInclude(h.log, "send click");
      }),
  );
});
