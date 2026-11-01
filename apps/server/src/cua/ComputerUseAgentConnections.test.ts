import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { CuaHostStatus } from "@goat/contracts";

import {
  FAILING_AFTER,
  make,
  nextFailure,
  reportedFailure,
  withAgentConnections,
} from "./ComputerUseAgentConnections.ts";

describe("ComputerUseAgentConnections", () => {
  it.effect("calls agent computer use failing only after a run of driver endings", () =>
    Effect.gen(function* () {
      const connections = yield* make;
      for (let ending = 1; ending < FAILING_AFTER; ending++) {
        yield* connections.report({ reason: "helper_refused" });
        assert.isUndefined(yield* connections.failure);
      }
      yield* connections.report({ reason: "helper_refused" });
      const failure = yield* connections.failure;
      assert.equal(failure?.failing, FAILING_AFTER);
      assert.equal(failure?.reason, "helper_refused");
      assert.include(failure?.message ?? "", "will not fix it");
    }),
  );

  it.effect("one working connection clears the run, so the next ending starts over", () =>
    Effect.gen(function* () {
      const connections = yield* make;
      for (let ending = 0; ending < FAILING_AFTER; ending++)
        yield* connections.report({ reason: "helper_restarted" });
      assert.isDefined(yield* connections.failure);
      yield* connections.report(false);
      assert.isUndefined(yield* connections.failure);
      yield* connections.report({ reason: "helper_restarted" });
      assert.isUndefined(yield* connections.failure);
    }),
  );

  it("names the latest reason when the endings change cause", () => {
    let current = nextFailure(undefined, { reason: "helper_restarted" });
    current = nextFailure(current, { reason: "helper_restarted" });
    current = nextFailure(current, { reason: "helper_unsupported" });
    assert.equal(reportedFailure(current)?.reason, "helper_unsupported");
    assert.equal(reportedFailure(current)?.failing, 3);
  });

  it("host status says agent tools are unavailable while agent connections keep failing", () => {
    const running: CuaHostStatus = { platform: "darwin", running: true, tools: "available" };
    const failing = { failing: 3, reason: "helper_refused", message: "refused" } as const;
    assert.deepEqual(withAgentConnections(running, undefined), running);
    assert.deepEqual(withAgentConnections(running, failing), {
      ...running,
      tools: "unavailable",
      failure: "refused",
      agentConnections: failing,
    });
    // A start failure the driver reported keeps its own sentence; off stays off.
    const failedStart = { ...running, tools: "unavailable", failure: "spawn failed" } as const;
    assert.equal(withAgentConnections(failedStart, failing).failure, "spawn failed");
    const off = { ...running, tools: "off" } as const;
    assert.deepEqual(withAgentConnections(off, failing), off);
  });
});
