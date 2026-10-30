import { assert, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Handoffs from "../handoffs/Handoffs.ts";
import { makeTestBrowserOriginGrants } from "../preview/BrowserOriginGrants.testkit.ts";
import { stopAllComputerUse, stopComputerUse } from "./ComputerUseRpcHandlers.ts";
import { active, call, harness } from "./ComputerUseLeaseProxy.testkit.ts";
import type { Union } from "../preview/BrowserOriginGrants.ts";

it.effect("Stop and Stop all end claims even without an active desktop lease", () =>
  Effect.gen(function* () {
    const published: Union[] = [];
    const grants = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: (union) => Effect.sync(() => void published.push(union)),
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
    for (const [threadId, windowId] of [
      [a, 7],
      [b, 8],
    ] as const) {
      const result = yield* grants.claim({
        threadId,
        pid: 42,
        windowId,
        origin: "https://example.test",
        windowTitle: "Browser",
      });
      assert.equal(result.agentResult.status, "attached");
    }
    const handoffs = yield* Handoffs.Handoffs;
    const session = AuthSessionId.make("session:test");
    const service = { ...grants, setDriverCapability: () => Effect.void };
    const proxy = yield* harness();
    yield* proxy.push({ ...active(), browserClaims: yield* grants.claimsFor(a) });
    yield* proxy.applied;
    yield* stopComputerUse(Option.none(), handoffs, session, a, Option.some(service));
    assert.lengthOf(yield* grants.claimsFor(a), 0);
    assert.lengthOf(yield* grants.claimsFor(b), 1);
    yield* proxy.push({ ...active(), browserClaims: yield* grants.claimsFor(a) });
    yield* proxy.applied;
    yield* proxy.send(call(1, "browser_click", { tab_id: "tab-7" }));
    assert.equal((yield* proxy.nextToProvider).id, 1);
    assert.equal(yield* proxy.driverQueued, 0);
    const rebound = yield* grants.claim({
      threadId: a,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    assert.equal(rebound.agentResult.status, "attached");
    yield* stopAllComputerUse(Option.none(), handoffs, session, Option.some(service));
    assert.lengthOf(yield* grants.claimsFor(a), 0);
    assert.lengthOf(yield* grants.claimsFor(b), 0);
    assert.deepEqual(published.at(-1), { existingProfiles: [], origins: [] });
  }).pipe(Effect.provide(Layer.mock(Handoffs.Handoffs)({}))),
);
