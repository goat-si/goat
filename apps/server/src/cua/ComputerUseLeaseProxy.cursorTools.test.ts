// @effect-diagnostics preferSchemaOverJson:off -- The fixture speaks MCP JSON-RPC lines.
import { assert, describe, it } from "@effect/vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import * as Effect from "effect/Effect";

import { CURSOR_OUTPUT_SCHEMA, helperCursorListing } from "./ComputerUseCursorTools.ts";
import { active, call, CONTROL, harness } from "./ComputerUseLeaseProxy.testkit.ts";
import {
  initialize,
  initialized,
  request,
  threadHarness,
} from "./ComputerUseLeaseProxyThread.testkit.ts";

const listedSchema = new AjvJsonSchemaValidator().getValidator(
  CURSOR_OUTPUT_SCHEMA as unknown as JsonSchemaType,
);
const structured = (answer: { result?: unknown }) =>
  (answer.result as { structuredContent?: unknown } | undefined)?.structuredContent;
const window = { pid: 4, window_id: 9 };
const show = (phase: string) =>
  "draw " + JSON.stringify({ op: "show", pid: 4, windowId: 9, phase });
const HIDE_IDLE = "draw " + JSON.stringify({ op: "hide", reason: "idle" });

describe("agent cursor tools on a helper that draws the cursor", () => {
  it.effect("answers from GOAT's cursor without reaching the driver, enabled by default", () =>
    Effect.gen(function* () {
      const h = yield* harness({ overlay: true, answersCursorTools: true });
      yield* h.push(active());
      yield* h.send(call(1, "get_agent_cursor_state", { session: "s1" }));
      const answer = yield* h.nextToProvider;
      assert.deepEqual(structured(answer), {
        session: "s1",
        enabled: true,
        visible: false,
        drawn_by: "goat_helper",
      });
      assert.isTrue(listedSchema(structured(answer)).valid);
      assert.notInclude(h.log.join("\n"), "send get_agent_cursor_state");
    }),
  );

  it.effect(
    "keeps the cursor off screen while disabled, still sends pauses to the helper, and redraws on enable",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ overlay: true, answersCursorTools: true });
        yield* h.push(active());
        yield* h.applied;
        yield* h.send(call(1, "click", { ...window, x: 1, y: 1 }));
        yield* h.nextToDriver;
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
        yield* h.nextToProvider;
        yield* h.send(call(2, "set_agent_cursor_enabled", { enabled: false }));
        assert.deepInclude(structured(yield* h.nextToProvider), { enabled: false, visible: false });
        yield* h.send(call(3, "click", { ...window, x: 2, y: 2 }));
        yield* h.nextToDriver;
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [] } }));
        yield* h.nextToProvider;
        yield* h.send(call(4, "set_agent_cursor_enabled", { enabled: true }));
        assert.deepInclude(structured(yield* h.nextToProvider), { enabled: true, visible: true });
        yield* h.send(call(5, "set_agent_cursor_enabled", { enabled: false }));
        yield* h.nextToProvider;
        yield* h.push({ state: "paused", controlId: CONTROL, reason: "takeover" });
        yield* h.applied;
        assert.deepEqual(h.log, [
          show("acting"),
          "send click",
          show("resting"),
          HIDE_IDLE,
          HIDE_IDLE,
          "send click",
          HIDE_IDLE,
          show("resting"),
          HIDE_IDLE,
          "draw " + JSON.stringify({ op: "hide", reason: "takeover" }),
        ]);
      }),
  );

  it.effect(
    "answers a malformed toggle and a style change in shapes the listed schema accepts",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ overlay: true, answersCursorTools: true });
        yield* h.push(active());
        yield* h.send(call(1, "set_agent_cursor_enabled", { enabled: "no" }));
        const malformed = yield* h.nextToProvider;
        assert.isTrue((malformed.result as { isError?: boolean }).isError);
        assert.isTrue(listedSchema(structured(malformed)).valid);
        yield* h.send(call(2, "set_agent_cursor_theme", { theme: "neon" }));
        const theme = yield* h.nextToProvider;
        assert.deepInclude(structured(theme), { applied: false, enabled: true });
        assert.isUndefined((theme.result as { isError?: boolean }).isError);
        assert.isTrue(listedSchema(structured(theme)).valid);
        assert.isTrue(
          listedSchema({ refused: "computer_use_refused", detail: "stopped" }).valid,
          "a proxy refusal of these tools stays inside the listed schema",
        );
        assert.deepEqual(h.log, []);
      }),
  );

  it.effect("forwards the cursor tools to a driver that draws its own cursor", () =>
    Effect.gen(function* () {
      const h = yield* harness({ overlay: true });
      yield* h.push(active());
      yield* h.send(call(1, "get_agent_cursor_state"));
      assert.equal((yield* h.nextToDriver).id, 1);
    }),
  );
});

describe("tool listings on a helper that draws the cursor", () => {
  const listing = (id: number) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          { name: "click", description: "Click.", inputSchema: { type: "object" } },
          {
            name: "get_agent_cursor_state",
            description: "Driver overlay.",
            inputSchema: { type: "object" },
            outputSchema: { type: "object", required: ["theme"] },
          },
        ],
      },
    });

  it("describes the cursor tools as GOAT answers them and leaves other lines alone", () => {
    const listed = JSON.parse(helperCursorListing(listing(1))) as {
      result: { tools: Array<{ name: string; description: string; outputSchema?: unknown }> };
    };
    assert.equal(listed.result.tools[0]?.description, "Click.");
    assert.include(listed.result.tools[1]?.description, "GOAT's on-screen agent cursor");
    assert.deepEqual(listed.result.tools[1]?.outputSchema, CURSOR_OUTPUT_SCHEMA);
    const driverRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "elicitation/create",
      params: { message: "set_agent_cursor_enabled?" },
    });
    assert.equal(helperCursorListing(driverRequest), driverRequest);
    const changed = JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    assert.equal(helperCursorListing(changed), changed);
  });

  it.effect("rewrites the listing a thread proxy answers between controls", () =>
    Effect.gen(function* () {
      const h = yield* threadHarness({
        toolsAt: () => (JSON.parse(listing(0)) as { result: never }).result,
        guide: helperCursorListing,
      });
      yield* h.push({ state: "waiting" });
      yield* h.send(initialize);
      yield* h.next;
      yield* h.send(initialized);
      yield* h.send(request(101, "tools/list"));
      const tools = (yield* h.next).result as { tools: Array<{ outputSchema?: unknown }> };
      assert.deepEqual(tools.tools[1]?.outputSchema, CURSOR_OUTPUT_SCHEMA);
    }),
  );
});
