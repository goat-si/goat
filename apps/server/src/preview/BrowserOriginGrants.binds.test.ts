import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeTestBrowserOriginGrants } from "./BrowserOriginGrants.testkit.ts";

it.effect("exposes binding authority only after approval and only to the owning thread", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const threadId = ThreadId.make("thread:one");
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.void,
      bind: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({
            targetId: "target-1",
            tabId: "tab",
            title: "Site",
            url: "https://example.test/",
            driverGeneration: 1,
          }),
        ),
    });
    const request = yield* service.request({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (request.status !== "pending") return assert.fail("expected pending");
    assert.deepEqual(yield* service.bindingsFor(threadId), []);
    const answer = yield* service
      .answer(request.claimId, true)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    assert.deepEqual(yield* service.bindingsFor(threadId), [
      { claimId: request.claimId, pid: 42, windowId: 7, origin: "https://example.test" },
    ]);
    assert.deepEqual(yield* service.bindingsFor(ThreadId.make("thread:other")), []);
    yield* Deferred.succeed(release, undefined);
    assert.equal((yield* Fiber.join(answer)).agentResult.status, "attached");
    assert.deepEqual(yield* service.bindingsFor(threadId), []);
  }),
);

it.effect("returns the bind and revision in one snapshot", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const threadId = ThreadId.make("thread:one");
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.void,
      bind: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({
            targetId: "target-1",
            tabId: "tab",
            title: "Site",
            url: "https://example.test/",
            driverGeneration: 1,
          }),
        ),
    });
    const request = yield* service.request({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (request.status !== "pending") return assert.fail("expected pending");
    const answer = yield* service
      .answer(request.claimId, true)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const snapshot = yield* service.snapshotFor(threadId);
    assert.equal(snapshot.revision, yield* service.revision);
    assert.deepEqual(snapshot.bindings, [
      { claimId: request.claimId, pid: 42, windowId: 7, origin: "https://example.test" },
    ]);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(answer);
  }),
);

it.effect("blocking an origin interrupts an approved bind without waiting for the driver", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let hosts: ReadonlyArray<string> = [];
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      blockedHosts: Effect.sync(() => hosts),
      publish: () => Effect.void,
      bind: (request) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({
            targetId: "target",
            tabId: "tab",
            title: "Site",
            url: request.origin,
            driverGeneration: 1,
          }),
        ),
    });
    const threadId = ThreadId.make("thread:blocked");
    const pending = yield* service.request({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (pending.status !== "pending") return assert.fail("expected pending");
    const answering = yield* service
      .answer(pending.claimId, true)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    hosts = ["example.test"];
    yield* service.blockedHostsChanged(hosts);
    const answer = yield* Fiber.join(answering);
    assert.equal(answer.agentResult.status === "refused" && answer.agentResult.code, "declined");
    assert.deepEqual(yield* service.list(threadId), { claims: [], grants: [] });
    yield* Deferred.succeed(release, undefined);
  }),
);
