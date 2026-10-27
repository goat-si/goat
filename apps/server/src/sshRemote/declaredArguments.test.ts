import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { AcpMcpBridgeError, type AcpMcpListedTool } from "../mcp/AcpMcpStdioBridge.ts";
import { declaredRequest } from "./declaredArguments.ts";

const request = {
  endpoint: "https://mini/mcp",
  authorization: "Bearer t",
  tool: "goat_thread_send",
};
const call = {
  arguments: { threadId: "lane", message: "Rebase" },
  optionalArguments: { remoteSender: { threadId: "coordinator" } },
};
const listing = (tools: ReadonlyArray<AcpMcpListedTool>) => () => Effect.succeed(tools);
const argumentsFor = (listTools: Parameters<typeof declaredRequest>[2]) =>
  declaredRequest(call, request, listTools).pipe(Effect.map((sent) => sent.arguments));

it.effect(
  "sends an optional argument only to a host whose tool declares it, asking on every call",
  () =>
    Effect.gen(function* () {
      const declares = listing([
        { name: "goat_thread_send", argumentNames: ["threadId", "message", "remoteSender"] },
      ]);
      const older = listing([{ name: "goat_thread_send", argumentNames: ["threadId", "message"] }]);
      assert.deepEqual(yield* argumentsFor(declares), {
        ...call.arguments,
        ...call.optionalArguments,
      });
      assert.deepEqual(yield* argumentsFor(older), call.arguments);
      // The same endpoint downgraded, then upgraded again: each call reads what is there now.
      let current = declares;
      const endpoint = () => current();
      assert.deepEqual(Object.keys(yield* argumentsFor(endpoint)), [
        "threadId",
        "message",
        "remoteSender",
      ]);
      current = older;
      assert.deepEqual(yield* argumentsFor(endpoint), call.arguments);
    }),
);

it.effect("a schemaless, missing or failed listing sends none of the optional arguments", () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* argumentsFor(listing([{ name: "goat_thread_send", argumentNames: [] }])),
      call.arguments,
    );
    assert.deepEqual(yield* argumentsFor(listing([])), call.arguments);
    assert.deepEqual(
      yield* argumentsFor(() => Effect.fail(new AcpMcpBridgeError("unreachable"))),
      call.arguments,
    );
  }),
);

it.effect("a call without optional arguments never lists the host's tools", () =>
  Effect.gen(function* () {
    let listed = 0;
    const sent = yield* declaredRequest({ arguments: call.arguments }, request, () => {
      listed += 1;
      return Effect.succeed([]);
    });
    assert.deepEqual(sent, { ...request, arguments: call.arguments });
    assert.equal(listed, 0);
  }),
);
