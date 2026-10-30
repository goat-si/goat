import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { makeBrowserOriginGrants } from "./BrowserOriginGrants.ts";

it.effect("does not bind before approval and hides a mismatch as a decline", () =>
  Effect.gen(function* () {
    const manifests: Array<unknown> = [];
    let binds = 0;
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: (union) => Effect.sync(() => void manifests.push(union)),
      bind: () =>
        Effect.sync(() => {
          binds++;
          return {
            tabId: "tab-1",
            title: "Private",
            url: "https://other.test/",
            driverGeneration: 1,
          };
        }),
    });
    const threadId = ThreadId.make("thread:test");
    const input = {
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    };
    const first = yield* service.request(input);
    assert.equal(first.status, "pending");
    assert.equal(binds, 0);
    if (first.status !== "pending") return;
    const mismatch = yield* service.answer(first.claimId, true);
    const second = yield* service.request(input);
    if (second.status !== "pending") return assert.fail("expected pending request");
    const decline = yield* service.answer(second.claimId, false);
    assert.deepEqual(mismatch.agentResult, decline.agentResult);
    assert.equal(mismatch.personMessage, "This tab is not on https://example.test");
    assert.deepEqual((yield* service.list(threadId)).grants, []);
    assert.equal(binds, 1);
    assert.deepEqual(manifests.at(-1), { existingProfiles: [], origins: [] });
  }),
);

it.effect("keeps grants per thread and shrinks the exact window union on revoke and stop", () =>
  Effect.gen(function* () {
    const manifests: Array<{
      readonly existingProfiles: ReadonlyArray<{ readonly pid: number; readonly windowId: number }>;
      readonly origins: ReadonlyArray<string>;
    }> = [];
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: (value) => Effect.sync(() => void manifests.push(value)),
      bind: (input) =>
        Effect.succeed({
          tabId: `tab-${input.windowId}`,
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const a = ThreadId.make("thread:a");
    const b = ThreadId.make("thread:b");
    for (const [threadId, windowId, origin] of [
      [a, 7, "https://one.test"],
      [b, 8, "https://two.test"],
    ] as const) {
      const request = yield* service.request({
        threadId,
        pid: 42,
        windowId,
        origin,
        windowTitle: "Browser",
      });
      if (request.status !== "pending") return assert.fail("expected pending request");
      yield* service.answer(request.claimId, true);
    }
    assert.deepEqual(manifests.at(-1), {
      existingProfiles: [
        { pid: 42, windowId: 7 },
        { pid: 42, windowId: 8 },
      ],
      origins: ["https://one.test", "https://two.test"],
    });
    assert.deepEqual(
      (yield* service.list(a)).grants.map((grant) => grant.origin),
      ["https://one.test"],
    );
    yield* service.revoke(a, "https://one.test");
    assert.deepEqual(manifests.at(-1), {
      existingProfiles: [{ pid: 42, windowId: 8 }],
      origins: ["https://two.test"],
    });
    yield* service.stop(b);
    assert.deepEqual(manifests.at(-1), { existingProfiles: [], origins: [] });
  }),
);
