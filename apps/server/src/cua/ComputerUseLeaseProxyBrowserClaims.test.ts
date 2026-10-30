import { describe, expect, it } from "vite-plus/test";
import {
  manifestApplied,
  browserReplyOutsideClaim,
  scopeBrowserCall,
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
  expect(
    manifestApplied(
      { capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null } },
      hash,
    ),
  ).toBe(true);
  expect(
    manifestApplied(
      { capability_manifest: { sha256: hash, file_sha256: "b".repeat(64), reload_error: null } },
      hash,
    ),
  ).toBe(false);
  expect(
    manifestApplied(
      { capability_manifest: { sha256: hash, file_sha256: hash, reload_error: "invalid" } },
      hash,
    ),
  ).toBe(false);
  expect(manifestApplied({}, hash)).toBe(false);
});

it("accepts the driver capability manifest only when applied and file hashes agree", () => {
  const hash = "a".repeat(64);
  expect(
    manifestApplied(
      { capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null } },
      hash,
    ),
  ).toBe(true);
  expect(
    manifestApplied(
      { capability_manifest: { sha256: "b".repeat(64), file_sha256: hash, reload_error: null } },
      hash,
    ),
  ).toBe(false);
  expect(
    manifestApplied(
      { capability_manifest: { sha256: hash, file_sha256: hash, reload_error: "invalid" } },
      hash,
    ),
  ).toBe(false);
});

it("detects an out-of-scope claimed tab reply without treating redacted other tabs as evidence", () => {
  const claim = {
    claimId: "claim-1",
    claimGeneration: 1,
    pid: 42,
    windowId: 7,
    tabId: "tab-1",
    origins: ["https://example.test"],
  };
  expect(
    browserReplyOutsideClaim(
      { structuredContent: { refusal: { code: "browser_origin_outside_scope" } } },
      claim,
    ),
  ).toBe(true);
  expect(
    browserReplyOutsideClaim(
      { structuredContent: { tab_id: "tab-1", url: "https://other.test/secret" } },
      claim,
    ),
  ).toBe(true);
  expect(
    browserReplyOutsideClaim(
      {
        structuredContent: {
          tabs: [
            { tab_id: "tab-1", url: "https://example.test/" },
            { tab_id: "tab-2", active: false },
          ],
        },
      },
      claim,
    ),
  ).toBe(false);
});

it("limits browser calls to the claimed tab and replaces caller supplied origin scopes", () => {
  const claims = [
    {
      claimId: "claim-1",
      claimGeneration: 1,
      pid: 42,
      windowId: 7,
      tabId: "tab-1",
      origins: ["https://example.test"],
    },
  ];
  expect(scopeBrowserCall("browser_click", { tab_id: "tab-2" }, claims)).toEqual({ refused: true });
  expect(scopeBrowserCall("browser_click", { tab_id: "tab-1" }, [])).toEqual({ refused: true });
  expect(scopeBrowserCall("browser_prepare", { pid: 42, window_id: 7 }, claims)).toEqual({
    refused: true,
  });
  expect(
    scopeBrowserCall(
      "browser_click",
      { tab_id: "tab-1", origin_scope: ["https://other.test"] },
      claims,
    ),
  ).toEqual({
    args: { tab_id: "tab-1", origin_scope: ["https://example.test"] },
    claimId: "claim-1",
    claimGeneration: 1,
  });
  expect(
    scopeBrowserCall(
      "run_steps",
      { steps: [{ tool: "browser_click", args: { tab_id: "tab-1" } }] },
      claims,
    ),
  ).toEqual({ refused: true });
});

it("refuses browser calls that name a different pid or window for the claimed tab", () => {
  const claims = [
    {
      claimId: "claim-1",
      claimGeneration: 1,
      pid: 42,
      windowId: 7,
      tabId: "tab-1",
      origins: ["https://example.test"],
    },
  ];
  expect(
    scopeBrowserCall("browser_click", { tab_id: "tab-1", pid: 43, window_id: 7 }, claims),
  ).toEqual({ refused: true });
  expect(
    scopeBrowserCall("browser_click", { tab_id: "tab-1", pid: 42, window_id: 8 }, claims),
  ).toEqual({ refused: true });
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

effectIt.effect("the proxy does not send an unclaimed browser call", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.push(active());
    yield* h.applied;
    yield* h.send(call(2, "browser_click", { tab_id: "unclaimed" }));
    const result = yield* Effect.raceFirst(
      h.nextToProvider.pipe(Effect.map(() => "refused")),
      h.nextToDriver.pipe(Effect.map(() => "sent")),
    );
    assert.equal(result, "refused");
  }),
);

effectIt.effect("the proxy replaces a caller origin scope for its claimed tab", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.push({
      ...active(),
      browserClaims: [
        {
          claimId: "claim-1",
          claimGeneration: 1,
          pid: 42,
          windowId: 7,
          tabId: "tab-1",
          origins: ["https://example.test"],
        },
      ],
    });
    yield* h.applied;
    yield* h.send(
      call(3, "browser_click", { tab_id: "tab-1", origin_scope: ["https://other.test"] }),
    );
    const result = yield* Effect.raceFirst(
      h.nextToProvider.pipe(Effect.map(() => ({ kind: "refused" as const }))),
      h.nextToDriver.pipe(Effect.map((message) => ({ kind: "sent" as const, message }))),
    );
    assert.equal(result.kind, "sent");
    if (result.kind === "sent")
      assert.deepEqual(result.message.params, {
        name: "browser_click",
        arguments: { tab_id: "tab-1", origin_scope: ["https://example.test"] },
      });
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

effectIt.effect("a revoked claim fences a browser call held before dispatch", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const h = yield* harness({ onTarget: () => true, targetGate: gate });
    const claim = {
      claimId: "claim-1",
      claimGeneration: 1,
      pid: 42,
      windowId: 7,
      tabId: "tab-1",
      origins: ["https://example.test"],
    };
    yield* h.push({ ...active(), browserClaims: [claim] });
    yield* h.applied;
    yield* h.send(call(1, "browser_click", { tab_id: "tab-1", pid: 42, window_id: 7 }));
    yield* h.reported;
    yield* h.push({ ...active(), browserClaims: [] });
    yield* h.applied;
    yield* Deferred.succeed(gate, undefined);
    assert.equal((yield* h.nextToProvider).id, 1);
    assert.equal(yield* h.driverQueued, 0);
  }),
);
