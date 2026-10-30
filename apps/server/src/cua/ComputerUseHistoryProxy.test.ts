import { assert, it } from "@effect/vitest";
import type { ComputerUseLeaseCallOutcome } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { active, call, harness } from "./ComputerUseLeaseProxy.testkit.ts";
import { callOutcome } from "./ComputerUseHistoryProxy.ts";

it("classifies the action outcome and drops text when the field is unknown", () => {
  const action = {
    tool: "type_text",
    args: { text: "secret" },
    app: { id: "fixture.app", name: "Fixture" },
  };
  const result = callOutcome(
    "control:a",
    action,
    JSON.stringify({ result: { content: [], structuredContent: { effect: "confirmed" } } }),
  );
  assert.deepInclude(result, {
    type: "callOutcome",
    controlId: "control:a",
    tool: "type_text",
    verdict: "sent",
  });
  assert.deepEqual(result?.typed, { length: 6, fieldKind: "unknown" });
  assert.deepEqual(
    callOutcome(
      "control:a",
      { tool: "set_value", args: { value: "secret" } },
      JSON.stringify({ result: { structuredContent: { effect: "confirmed" } } }),
    )?.typed,
    { length: 6, fieldKind: "unknown" },
  );
  const refused = callOutcome(
    "control:a",
    action,
    JSON.stringify({
      result: { isError: true, structuredContent: { refused: "not permitted", detail: "expired" } },
    }),
  );
  assert.deepInclude(refused, { verdict: "refused", refusalCode: "expired" });
  assert.isUndefined(
    callOutcome(
      "control:a",
      { tool: "get_window_state", args: {} },
      JSON.stringify({ result: {} }),
    ),
  );
});

it.effect("reports one sent click and does not report a read", () =>
  Effect.gen(function* () {
    const reports = yield* Queue.unbounded<ComputerUseLeaseCallOutcome>();
    const h = yield* harness({ onCallOutcome: (report) => Queue.offer(reports, report) });
    yield* h.push(active());
    yield* h.send(call(7, "list_apps"));
    yield* h.nextToDriver;
    yield* h.reply(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        result: {
          structuredContent: { apps: [{ pid: 4, bundle_id: "fixture.app", name: "Fixture" }] },
        },
      }),
    );
    yield* h.nextToProvider;
    yield* h.send(call(1, "click", { pid: 4, window_id: 9 }));
    yield* h.nextToDriver;
    yield* h.reply(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { structuredContent: { effect: "confirmed" } },
      }),
    );
    yield* h.nextToProvider;
    assert.deepInclude(yield* Queue.take(reports), {
      verdict: "sent",
      app: { id: "fixture.app", name: "Fixture" },
    });
    yield* h.send(call(2, "get_window_state", { pid: 4, window_id: 9 }));
    yield* h.nextToDriver;
    yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }));
    yield* h.nextToProvider;
    assert.equal(yield* Queue.size(reports), 0);
  }),
);

it.effect("reports a server admission refusal without dispatch", () =>
  Effect.gen(function* () {
    const reports = yield* Queue.unbounded<ComputerUseLeaseCallOutcome>();
    const h = yield* harness({
      onCallOutcome: (report) => Queue.offer(reports, report),
      reservation: () => Effect.succeed({ status: "refused", detail: "target_busy" }),
    });
    yield* h.push(active());
    yield* h.send(call(1, "click", { pid: 4, window_id: 9 }));
    yield* h.nextToProvider;
    assert.deepInclude(yield* Queue.take(reports), {
      verdict: "refused",
      refusalCode: "target_busy",
    });
    assert.equal(yield* h.driverQueued, 0);
  }),
);
