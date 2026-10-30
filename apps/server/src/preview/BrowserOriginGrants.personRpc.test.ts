import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class WindowMissing extends Schema.TaggedError<WindowMissing>()("WindowMissing", {}) {}
import { makeTestBrowserOriginGrants } from "./BrowserOriginGrants.testkit.ts";

it.effect(
  "person listing exposes pending requests across threads without binding or granting",
  () =>
    Effect.gen(function* () {
      let binds = 0;
      const service = yield* makeTestBrowserOriginGrants({
        environmentId: EnvironmentId.make("environment:test"),
        supported: () => true,
        publish: () => Effect.void,
        bind: (input) =>
          Effect.sync(() => {
            binds++;
            return { tabId: "tab", title: "Site", url: input.origin, driverGeneration: 1 };
          }),
      });
      const threadId = ThreadId.make("thread:one");
      const pending = yield* service.request({
        threadId,
        pid: 42,
        windowId: 7,
        origin: "https://example.test",
        windowTitle: "Browser",
      });
      if (pending.status !== "pending") return assert.fail("expected pending");
      assert.deepEqual((yield* service.listAll()).pending, [
        {
          claimId: pending.claimId,
          threadId,
          pid: 42,
          windowId: 7,
          origin: "https://example.test",
          windowTitle: "Browser",
          createdAt: 0,
        },
      ]);
      assert.deepEqual(yield* service.list(threadId), { claims: [], grants: [] });
      assert.equal(binds, 0);
    }),
);

it.effect("person claim and end attach once and keep the approved grant", () =>
  Effect.gen(function* () {
    let binds = 0;
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.void,
      bind: (input) =>
        Effect.sync(() => {
          binds++;
          return { tabId: "tab", title: "Site", url: input.origin, driverGeneration: 1 };
        }),
    });
    const threadId = ThreadId.make("thread:one");
    const answer = yield* service.claim({
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (answer.agentResult.status !== "attached") return assert.fail("expected attached");
    assert.equal(binds, 1);
    assert.isTrue(yield* service.endPerson(answer.agentResult.claim.claimId));
    assert.deepEqual((yield* service.list(threadId)).claims, []);
    assert.lengthOf((yield* service.list(threadId)).grants, 1);
  }),
);

it.effect("agent requests use the observed window title and refuse missing windows", () =>
  Effect.gen(function* () {
    let reads = 0;
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.void,
      bind: () => Effect.die("must not bind"),
      windowTitle: (target) =>
        Effect.sync(() => {
          reads++;
          return target.windowId === 7 ? "Observed browser" : undefined;
        }).pipe(
          Effect.filterOrFail(
            (title): title is "Observed browser" => title !== undefined,
            () => new WindowMissing(),
          ),
        ),
    });
    const input = {
      threadId: ThreadId.make("thread:one"),
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
    };
    const result = yield* service.requestWindow(input);
    assert.equal(result.status, "pending");
    assert.equal((yield* service.listAll()).pending[0]?.windowTitle, "Observed browser");
    assert.equal(
      (yield* service.requestWindow({ ...input, windowId: 8 }).pipe(Effect.result))._tag,
      "Failure",
    );
    assert.equal(reads, 2);
  }),
);
