import { describe, expect, it } from "vite-plus/test";
import {
  manifestApplied,
  refusesClaimedBrowserDesktopCall,
  supportsBrowserClaims,
} from "./ComputerUseLeaseProxyBrowserClaims.ts";
import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { active, call, harness } from "./ComputerUseLeaseProxy.testkit.ts";

describe("browser claim capability", () => {
  it("requires origin_scope on the driver's get_browser_state schema", () => {
    expect(supportsBrowserClaims({ tools: [] })).toBe(false);
    expect(
      supportsBrowserClaims({
        tools: [{ name: "get_browser_state", inputSchema: { properties: {} } }],
      }),
    ).toBe(false);
    expect(
      supportsBrowserClaims({
        tools: [{ name: "other", inputSchema: { properties: { origin_scope: {} } } }],
      }),
    ).toBe(false);
    expect(
      supportsBrowserClaims({
        tools: [
          {
            name: "get_browser_state",
            inputSchema: { properties: { origin_scope: { type: "array" } } },
          },
        ],
      }),
    ).toBe(true);
  });
});

it("requires the applied manifest hash and no reload error", () => {
  const hash = "a".repeat(64);
  expect(manifestApplied({ capability_manifest_file_sha256: hash }, hash)).toBe(true);
  expect(manifestApplied({ capability_manifest_file_sha256: "b".repeat(64) }, hash)).toBe(false);
  expect(
    manifestApplied(
      { capability_manifest_file_sha256: hash, capability_manifest_reload_error: "invalid" },
      hash,
    ),
  ).toBe(false);
  expect(manifestApplied({}, hash)).toBe(false);
});

it("refuses desktop calls to a host-wide claimed browser pid", () => {
  expect(refusesClaimedBrowserDesktopCall("click", { pid: 42, window_id: 7 }, [42])).toBe(true);
  expect(refusesClaimedBrowserDesktopCall("click", { pid: 43, window_id: 7 }, [42])).toBe(false);
  expect(
    refusesClaimedBrowserDesktopCall("run_steps", { steps: [{ tool: "click", pid: 42 }] }, [42]),
  ).toBe(true);
});

effectIt.effect("the proxy refuses a desktop call for a claimed browser pid", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.push({ ...active(), claimedBrowserPids: [42] });
    yield* h.applied;
    yield* h.send(call(1, "click", { pid: 42, window_id: 7, x: 1, y: 1 }));
    const reply = yield* h.nextToProvider;
    assert.equal(reply.id, 1);
    assert.equal(yield* h.driverQueued, 0);
  }),
);

effectIt.effect("a newly claimed pid fences a desktop call held before dispatch", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const h = yield* harness({ onTarget: () => true, targetGate: gate });
    yield* h.push(active());
    yield* h.applied;
    yield* h.send(call(1, "click", { pid: 42, window_id: 7, x: 1, y: 1 }));
    yield* h.reported;
    yield* h.push({ ...active(), claimedBrowserPids: [42] });
    yield* h.applied;
    yield* Deferred.succeed(gate, undefined);
    assert.equal((yield* h.nextToProvider).id, 1);
    assert.equal(yield* h.driverQueued, 0);
  }),
);
