import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { makeBrowserOriginGrants, type Union } from "./BrowserOriginGrants.ts";

class ConfigFailure extends Schema.TaggedError<ConfigFailure>()("ConfigFailure", {}) {}
const hash = "a".repeat(64);
const input = {
  threadId: ThreadId.make("thread:test"),
  pid: 42,
  windowId: 7,
  origin: "https://example.test",
  windowTitle: "Browser",
};
const config = (file: string, error: string | null = null) => ({
  capability_manifest: { sha256: hash, file_sha256: file, reload_error: error },
});
const bind = (request: typeof input) =>
  Effect.succeed({
    targetId: "target-1",
    tabId: `tab-${request.windowId}`,
    title: "Site",
    url: request.origin,
    driverGeneration: 1,
  });

it.effect("does not bind or attach until the written hash is confirmed", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const result = yield* Deferred.make<unknown>();
    let bindings = 0;
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.succeed(hash),
      confirm: () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(result))),
      bind: (request) =>
        Effect.sync(() => {
          bindings++;
          return {
            targetId: "target-1",
            tabId: "tab",
            title: "Site",
            url: request.origin,
            driverGeneration: 1,
          };
        }),
    });
    const request = yield* service.request(input);
    if (request.status !== "pending") return assert.fail("expected pending");
    const answer = yield* service
      .answer(request.claimId, true)
      .pipe(Effect.forkChild({ startImmediately: true }));
    assert.isTrue(Option.isSome(yield* Deferred.poll(entered)));
    yield* Deferred.await(entered);
    assert.equal(bindings, 0);
    yield* Deferred.succeed(result, config(hash));
    assert.equal((yield* Fiber.join(answer)).agentResult.status, "attached");
    assert.equal(bindings, 1);
  }),
);

it.effect.each([
  { name: "mismatched file hash", response: Effect.succeed(config("b".repeat(64))) },
  { name: "reload error", response: Effect.succeed(config(hash, "invalid")) },
  { name: "get_config failure", response: Effect.fail(new ConfigFailure()) },
])("refuses $name like a decline and restores the previous union", ({ response }) =>
  Effect.gen(function* () {
    const published: Union[] = [];
    let calls = 0;
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: (value) =>
        Effect.sync(() => {
          published.push(value);
          return hash;
        }),
      confirm: () => (++calls === 1 ? Effect.succeed(config(hash)) : response),
      bind,
    });
    const first = yield* service.request(input);
    if (first.status !== "pending") return assert.fail("expected pending");
    assert.equal((yield* service.answer(first.claimId, true)).agentResult.status, "attached");
    const declined = yield* service.request({ ...input, windowId: 9 });
    if (declined.status !== "pending") return assert.fail("expected pending");
    const decline = yield* service.answer(declined.claimId, false);
    const second = yield* service.request({ ...input, windowId: 8 });
    if (second.status !== "pending") return assert.fail("expected pending");
    const answer = yield* service.answer(second.claimId, true);
    assert.equal(JSON.stringify(answer.agentResult), JSON.stringify(decline.agentResult));
    assert.deepEqual(published.at(-1), {
      existingProfiles: [{ pid: 42, windowId: 7 }],
      origins: ["https://example.test"],
    });
    assert.lengthOf(yield* service.claimsFor(input.threadId), 1);
  }),
);

it.effect("a shrink returns before its confirmation finishes", () =>
  Effect.gen(function* () {
    const shrinkStarted = yield* Deferred.make<void>();
    const shrinkResult = yield* Deferred.make<unknown>();
    let calls = 0;
    const service = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.succeed(hash),
      confirm: () =>
        ++calls === 1
          ? Effect.succeed(config(hash))
          : Deferred.succeed(shrinkStarted, undefined).pipe(
              Effect.andThen(Deferred.await(shrinkResult)),
            ),
      bind,
    });
    const request = yield* service.request(input);
    if (request.status !== "pending") return assert.fail("expected pending");
    assert.equal((yield* service.answer(request.claimId, true)).agentResult.status, "attached");
    yield* service.revoke(input.threadId, input.origin);
    assert.isTrue(Option.isSome(yield* Deferred.poll(shrinkStarted)));
    yield* Deferred.await(shrinkStarted);
    assert.deepEqual(yield* service.claimsFor(input.threadId), []);
    yield* Deferred.succeed(shrinkResult, config(hash));
  }),
);
