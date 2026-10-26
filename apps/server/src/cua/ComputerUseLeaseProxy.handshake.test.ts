import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { active, call, CONTROL, harness } from "./ComputerUseLeaseProxy.testkit.ts";

const request = (id: number, method: string, params: object = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });
const initialize = request(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "codex", version: "0.163.0" },
});
const initialized = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
const serverInfo = { protocolVersion: "2025-06-18", serverInfo: { name: "cua-driver" } };
/** A handshake child starts, where the proxy used to refuse the request at once. */
const handshakeChild = (h: Effect.Success<ReturnType<typeof harness>>) =>
  Effect.raceFirst(
    h.restarted.pipe(Effect.as("child")),
    h.nextToProvider.pipe(Effect.map((answer) => JSON.stringify(answer))),
  );
const tools = { tools: [{ name: "list_windows", inputSchema: { type: "object" } }] };
const newerTools = { tools: [...tools.tools, { name: "zoom", inputSchema: { type: "object" } }] };

// A paused control has no driver, but MCP clients drop a server whose handshake fails, so the
// agent would lose its tools for the session (#1604). Only tool calls wait for the person.
describe("proxy handshake while computer use is paused (#1604)", () => {
  it.effect(
    "answers initialize and tools/list from a driver that never hears a call, and refuses calls with the pause reason",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.push({ state: "paused", controlId: CONTROL, reason: "private" });
        yield* h.applied;
        yield* h.killed;

        yield* h.send(initialize);
        assert.equal(yield* handshakeChild(h), "child");
        const init = yield* h.nextToDriver;
        assert.equal(init.method, "initialize");
        assert.notEqual(init.id, 1);
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: init.id, result: serverInfo }));
        assert.deepEqual(yield* h.nextToProvider, { jsonrpc: "2.0", id: 1, result: serverInfo });

        yield* h.send(initialized);
        yield* h.send(request(2, "tools/list"));
        assert.equal(yield* handshakeChild(h), "child");
        const again = yield* h.nextToDriver;
        assert.equal(again.method, "initialize");
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: again.id, result: serverInfo }));
        assert.equal((yield* h.nextToDriver).method, "notifications/initialized");
        const list = yield* h.nextToDriver;
        assert.equal(list.method, "tools/list");
        assert.notEqual(list.id, 2);
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: list.id, result: tools }));
        assert.deepEqual(yield* h.nextToProvider, { jsonrpc: "2.0", id: 2, result: tools });

        yield* h.send(call(3, "list_windows"));
        const refused = (yield* h.nextToProvider) as {
          id: number;
          result: { structuredContent: { detail: string } };
        };
        assert.equal(refused.id, 3);
        assert.equal(refused.result.structuredContent.detail, "private_mode");
        // The handshake drivers are gone, and none of them heard a tool call.
        assert.equal(yield* h.liveDrivers, 0);
        assert.deepEqual(h.log, []);

        // A cached listing answers again without another driver.
        yield* h.send(request(4, "tools/list"));
        assert.deepEqual(yield* h.nextToProvider, { jsonrpc: "2.0", id: 4, result: tools });
        assert.equal(yield* h.startedQueued, 0);

        // The resumed child confirms the tools the provider was given; a changed driver's list
        // tells the provider to list again.
        yield* h.push(active());
        yield* h.restarted;
        assert.equal((yield* h.nextToDriver).method, "initialize");
        assert.equal((yield* h.nextToDriver).method, "notifications/initialized");
        const recheck = yield* h.nextToDriver;
        assert.equal(recheck.method, "tools/list");
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: recheck.id, result: newerTools }));
        assert.deepEqual(yield* h.nextToProvider, {
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
        });
        yield* h.send(request(5, "tools/list"));
        assert.equal((yield* h.nextToDriver).id, 5);
        yield* h.send(call(6, "list_windows"));

        // Every line the two short-lived children heard is handshake; the only tool call any
        // driver heard is the one sent after the resume, to the resumed child.
        const heard: Array<{ index: number; message: Record<string, unknown> }> = [];
        let dispatch = yield* h.nextDispatch;
        while (dispatch.message.id !== 6) {
          heard.push(dispatch);
          dispatch = yield* h.nextDispatch;
        }
        assert.equal(dispatch.index, 3);
        assert.isFalse(heard.some((line) => line.message.method === "tools/call"));
        assert.deepEqual(
          heard
            .filter((line) => line.index === 1 || line.index === 2)
            .map((line) => line.message.method),
          ["initialize", "initialize", "notifications/initialized", "tools/list"],
        );
      }),
  );

  it.effect("answers a handshake request that a pause cut off from its driver", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.send(initialize);
      assert.equal((yield* h.nextToDriver).method, "initialize");
      yield* h.push({ state: "paused", controlId: CONTROL, reason: "takeover" });
      yield* h.killed;
      assert.equal(yield* handshakeChild(h), "child");
      const init = yield* h.nextToDriver;
      assert.equal(init.method, "initialize");
      assert.notEqual(init.id, 1);
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: init.id, result: serverInfo }));
      assert.deepEqual(yield* h.nextToProvider, { jsonrpc: "2.0", id: 1, result: serverInfo });
    }),
  );

  it.effect.each(["stop", "cancel"] as const)(
    "a %s while a handshake child answers kills it, and its answer never reaches the provider",
    (ending) =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.push({ state: "paused", controlId: CONTROL, reason: "private" });
        yield* h.applied;
        yield* h.killed;
        yield* h.send(initialize);
        assert.equal(yield* handshakeChild(h), "child");
        const init = yield* h.nextToDriver;
        const child = h.drivers[1];
        assert.isDefined(child);
        if (ending === "stop") {
          yield* h.push({ state: "ended", reason: "stopped" });
          const answer = (yield* h.nextToProvider) as {
            id: number;
            error?: { data?: { detail?: string } };
            result?: unknown;
          };
          assert.equal(answer.id, 1);
          assert.isUndefined(answer.result);
        } else
          yield* h.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: 1 },
            }),
          );
        yield* Deferred.await(child!.killed);
        // A late answer from the killed child is dropped.
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: init.id, result: serverInfo }));
        yield* h.send(request(9, "ping"));
        const next = yield* h.nextToProvider;
        assert.equal(next.id, 9);
      }),
  );
});
