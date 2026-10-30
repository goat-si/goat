import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
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
