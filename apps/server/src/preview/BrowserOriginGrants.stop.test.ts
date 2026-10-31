import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { makeTestBrowserOriginGrants } from "./BrowserOriginGrants.testkit.ts";

it.effect("stopping one thread ends its claims and preserves other claims and grants", () =>
  Effect.gen(function* () {
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.void,
      bind: (input) =>
        Effect.succeed({
          targetId: "target-1",
          tabId: `tab-${input.windowId}`,
          title: "Site",
          url: input.origin,
          driverGeneration: 1,
        }),
    });
    const first = ThreadId.make("thread:first");
    const other = ThreadId.make("thread:other");
    const a = yield* service.claim({
      threadId: first,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    const b = yield* service.claim({
      threadId: other,
      pid: 43,
      windowId: 8,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (a.agentResult.status !== "attached" || b.agentResult.status !== "attached")
      return assert.fail("expected attached claims");
    yield* service.stop(first);
    assert.equal(yield* service.endReason(first, a.agentResult.claim.claimId), "stopped");
    assert.lengthOf(yield* service.claimsFor(first), 0);
    assert.lengthOf(yield* service.claimsFor(other), 1);
    assert.lengthOf((yield* service.list(first)).grants, 1);
  }),
);

it.effect("stop fences a pending bind without waiting for it", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.void,
      bind: (input) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({
            targetId: "target-1",
            tabId: "tab",
            title: "Site",
            url: input.origin,
            driverGeneration: 1,
          }),
        ),
    });
    const threadId = ThreadId.make("thread:first");
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
    yield* Deferred.await(started);
    yield* service.stop(threadId);
    assert.equal((yield* Fiber.join(answering)).agentResult.status, "refused");
    yield* Deferred.succeed(release, undefined);
    assert.deepEqual(yield* service.claimsFor(threadId), []);
  }),
);
