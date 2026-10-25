import { assert, describe, it } from "@effect/vitest";
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

        yield* h.push(active());
        yield* h.restarted;
        yield* h.send(call(5, "list_windows"));
        // Of every line any driver heard, the only tool call is this one, sent to the resumed child.
        let dispatch = yield* h.nextDispatch;
        while (dispatch.message.method !== "tools/call") dispatch = yield* h.nextDispatch;
        assert.equal(dispatch.message.id, 5);
        assert.equal(dispatch.index, h.drivers.length - 1);
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
});
