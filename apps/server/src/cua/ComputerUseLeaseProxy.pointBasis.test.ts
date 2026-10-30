import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { POINT_BASIS_UNSUPPORTED } from "./ComputerUseLeaseProxyPointBasis.ts";
import { active, call, harness } from "./ComputerUseLeaseProxy.testkit.ts";

const at = { pid: 4, window_id: 9, x: 20, y: 16, snapshot_id: "s0000001b" };
/** A tools/list answer whose click tools do or do not take a snapshot_id. */
const toolList = (basis: boolean) => ({
  tools: ["click", "double_click", "right_click"].map((name) => ({
    name,
    inputSchema: {
      type: "object",
      properties: basis ? { x: {}, y: {}, snapshot_id: { type: "string" } } : { x: {}, y: {} },
    },
  })),
});
const listedTools = Effect.fn(function* (
  h: Effect.Success<ReturnType<typeof harness>>,
  basis: boolean,
) {
  const probe = yield* h.nextToDriver;
  assert.equal(probe.method, "tools/list");
  yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: probe.id, result: toolList(basis) }));
});
const refusalOf = (answer: Record<string, unknown>) =>
  (answer.result as { structuredContent: Record<string, unknown> }).structuredContent;

it.effect(
  "a point click naming a window basis reaches only a driver whose click takes snapshot_id; another driver refuses it unsent",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      for (const tool of ["click", "double_click", "right_click"]) {
        yield* h.send(call(tool, tool, at));
        if (tool === "click") yield* listedTools(h, false);
        const refused = yield* h.nextToProvider;
        assert.equal(refused.id, tool);
        assert.deepInclude(refusalOf(refused), { detail: "outside_manifest" });
        assert.include(
          (refused.result as { content: ReadonlyArray<{ text: string }> }).content[0]?.text,
          POINT_BASIS_UNSUPPORTED,
        );
      }
      // A step of a batch is held to the same rule.
      yield* h.send(call("steps", "run_steps", { steps: [{ tool: "click", args: at }] }));
      assert.deepInclude(refusalOf(yield* h.nextToProvider), { detail: "outside_manifest" });
      assert.equal(yield* h.driverQueued, 0);
      // A click without a basis is not this check's business.
      yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      assert.equal((yield* h.nextToDriver).id, 1);
    }),
);

it.effect("a driver whose click takes snapshot_id gets the point click as written", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.push(active());
    yield* h.send(call(1, "click", at));
    yield* listedTools(h, true);
    const sent = yield* h.nextToDriver;
    assert.equal(sent.id, 1);
    assert.deepEqual((sent.params as { arguments: unknown }).arguments, at);
  }),
);
