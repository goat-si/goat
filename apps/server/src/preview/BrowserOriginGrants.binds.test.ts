import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { makeTestBrowserOriginGrants } from "./BrowserOriginGrants.testkit.ts";

class HostsUnavailable extends Schema.TaggedError<HostsUnavailable>()("HostsUnavailable", {}) {}

it.effect("exposes binding authority only after approval and only to the owning thread", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const threadId = ThreadId.make("thread:one");
    let hostsAvailable = true;
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      blockedHosts: Effect.suspend(() =>
        hostsAvailable ? Effect.succeed([]) : Effect.fail(new HostsUnavailable()),
      ),
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
    const admitted = yield* Deferred.make<void>();
    const bindCall = yield* service
      .admitClaimCall(
        threadId,
        "get_browser_state",
        {
          pid: 42,
          window_id: 7,
          origin_scope: ["https://example.test"],
          session: `goat-claim:${request.claimId}`,
        },
        [],
      )
      .pipe(
        Effect.tap(() => Deferred.succeed(admitted, undefined)),
        Effect.forkChild({ startImmediately: true }),
      );
    assert.isTrue(Option.isSome(yield* Deferred.poll(admitted)));
    assert.equal((yield* Fiber.join(bindCall)).status, "admit");
    const bindArgs = {
      pid: 42,
      window_id: 7,
      origin_scope: ["https://example.test"],
      session: `goat-claim:${request.claimId}`,
    };
    const bindIdentity = { claimId: request.claimId, origin: "https://example.test" };
    assert.equal(
      (yield* service.verifyBindCall(threadId, "get_browser_state", bindArgs, [], bindIdentity))
        .status,
      "admit",
    );
    hostsAvailable = false;
    assert.equal(
      (yield* service.verifyBindCall(threadId, "get_browser_state", bindArgs, [], bindIdentity))
        .status,
      "blocked",
    );
    hostsAvailable = true;
    assert.deepEqual(yield* service.bindingsFor(ThreadId.make("thread:other")), []);
    yield* Deferred.succeed(release, undefined);
    assert.equal((yield* Fiber.join(answer)).agentResult.status, "attached");
    assert.deepEqual(yield* service.bindingsFor(threadId), []);
    assert.equal(
      (yield* service.verifyBindCall(threadId, "get_browser_state", bindArgs, [], bindIdentity))
        .status,
      "outside",
    );
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

it.effect("a block during a bind cannot end its request before the answer is settled", () =>
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
    const unrelatedDone = yield* Deferred.make<void>();
    const unrelated = yield* service.admitClaimCall(threadId, "list_apps", {}, []).pipe(
      Effect.tap(() => Deferred.succeed(unrelatedDone, undefined)),
      Effect.forkChild({ startImmediately: true }),
    );
    assert.isTrue(Option.isSome(yield* Deferred.poll(unrelatedDone)));
    assert.equal((yield* Fiber.join(unrelated)).status, "admit");
    hosts = ["example.test"];
    const blockedDone = yield* Deferred.make<void>();
    const blocked = yield* service.blockedHostsChanged(hosts).pipe(
      Effect.tap(() => Deferred.succeed(blockedDone, undefined)),
      Effect.forkChild({ startImmediately: true }),
    );
    assert.isTrue(Option.isNone(yield* Deferred.poll(blockedDone)));
    yield* Deferred.succeed(release, undefined);
    const answer = yield* Fiber.join(answering);
    yield* Fiber.join(blocked);
    assert.equal(answer.agentResult.status === "refused" && answer.agentResult.code, "declined");
    assert.deepEqual(yield* service.list(threadId), { claims: [], grants: [] });
  }),
);
