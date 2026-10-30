import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
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

it.effect("does not grant a noncanonical origin or use an unsupported driver", () =>
  Effect.gen(function* () {
    let supported = false;
    let published = 0;
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => supported,
      publish: () =>
        Effect.sync(() => {
          published++;
        }),
      bind: () => Effect.die("bind must not run"),
    });
    const input = {
      threadId: ThreadId.make("thread:test"),
      pid: 42,
      windowId: 7,
      origin: "https://example.test/",
      windowTitle: "Browser",
    };
    const unavailable = yield* service.request(input);
    assert.equal(unavailable.status, "refused");
    if (unavailable.status === "refused") assert.equal(unavailable.code, "unavailable");
    supported = true;
    const invalid = yield* service.request(input);
    assert.equal(invalid.status, "refused");
    if (invalid.status === "refused") assert.equal(invalid.code, "invalid_origin");
    assert.equal(published, 0);
  }),
);

it.effect("serializes a revoke behind an in-flight bind", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.void,
      bind: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({
            tabId: "tab",
            title: "Site",
            url: "https://example.test",
            driverGeneration: 1,
          }),
        ),
    });
    const threadId = ThreadId.make("thread:test");
    const request = yield* service.request({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (request.status !== "pending") return assert.fail("expected pending request");
    const answer = yield* service.answer(request.claimId, true).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const revoked = yield* service.revoke(threadId, "https://example.test").pipe(Effect.forkChild);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(answer);
    yield* Fiber.join(revoked);
    assert.deepEqual(yield* service.list(threadId), { grants: [], claims: [] });
  }),
);
