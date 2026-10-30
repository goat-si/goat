import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { makeTestBrowserOriginGrants as makeBrowserOriginGrants } from "./BrowserOriginGrants.testkit.ts";

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
    assert.equal(
      "personMessage" in mismatch ? mismatch.personMessage : undefined,
      "This tab is not on https://example.test",
    );
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

it.effect("ends only the matching claim generation when its origin changes", () =>
  Effect.gen(function* () {
    const manifests: Array<unknown> = [];
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: (value) => Effect.sync(() => void manifests.push(value)),
      bind: () =>
        Effect.succeed({
          tabId: "tab-1",
          title: "Site",
          url: "https://example.test/",
          driverGeneration: 1,
        }),
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
    const answer = yield* service.answer(request.claimId, true);
    if (answer.agentResult.status !== "attached") return assert.fail("expected attached claim");
    const generation = answer.agentResult.claim.claimGeneration;
    const stale = yield* service.end(threadId, request.claimId, generation + 1, "origin_changed");
    assert.isFalse(stale);
    assert.lengthOf((yield* service.list(threadId)).claims, 1);
    const ended = yield* service.end(threadId, request.claimId, generation, "origin_changed");
    assert.isTrue(ended);
    assert.equal(yield* service.endReason(threadId, request.claimId), "origin_changed");
    assert.deepEqual((yield* service.list(threadId)).claims, []);
    assert.deepEqual(manifests.at(-1), { existingProfiles: [], origins: [] });
  }),
);

it.effect("exposes each thread's claims and fences claimed browser pids until revoked", () =>
  Effect.gen(function* () {
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.void,
      bind: () =>
        Effect.succeed({
          tabId: "tab-1",
          title: "Site",
          url: "https://example.test",
          driverGeneration: 1,
        }),
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
    const answer = yield* service.answer(request.claimId, true);
    if (answer.agentResult.status !== "attached") return assert.fail("expected attached claim");
    assert.deepEqual(yield* service.claimsFor(threadId), [
      {
        claimId: request.claimId,
        claimGeneration: answer.agentResult.claim.claimGeneration,
        pid: 42,
        windowId: 7,
        tabId: "tab-1",
        origins: ["https://example.test"],
      },
    ]);
    assert.deepEqual(yield* service.claimsFor(ThreadId.make("thread:other")), []);
    assert.deepEqual(yield* service.claimedPids(), [42]);
    assert.isFalse(
      yield* service.end(
        ThreadId.make("thread:other"),
        request.claimId,
        answer.agentResult.claim.claimGeneration,
        "origin_changed",
      ),
    );
    yield* service.revoke(threadId, "https://example.test");
    assert.deepEqual(yield* service.claimsFor(threadId), []);
    assert.deepEqual(yield* service.claimedPids(), []);
  }),
);

class ManifestConfirmationMismatch extends Schema.TaggedError<ManifestConfirmationMismatch>()(
  "ManifestConfirmationMismatch",
  {},
) {}

it.effect("refuses a claim when manifest confirmation fails and restores the previous union", () =>
  Effect.gen(function* () {
    const published: Array<ReadonlyArray<{ readonly pid: number; readonly windowId: number }>> = [];
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: (union) =>
        Effect.gen(function* () {
          published.push(union.existingProfiles);
          if (union.existingProfiles.some((entry) => entry.windowId === 8))
            return yield* new ManifestConfirmationMismatch();
        }),
      bind: (input) =>
        Effect.succeed({
          tabId: `tab-${input.windowId}`,
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
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
    if (first.status !== "pending") return assert.fail("expected pending request");
    const accepted = yield* service.answer(first.claimId, true);
    assert.equal(accepted.agentResult.status, "attached");
    const second = yield* service.request({ ...input, windowId: 8 });
    if (second.status !== "pending") return assert.fail("expected pending request");
    const answer = yield* service.answer(second.claimId, true);
    assert.equal(answer.agentResult.status, "refused");
    assert.deepEqual(published.at(-1), [{ pid: 42, windowId: 7 }]);
    assert.lengthOf(yield* service.claimsFor(threadId), 1);
  }),
);
