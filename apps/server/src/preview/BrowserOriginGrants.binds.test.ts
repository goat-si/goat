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
