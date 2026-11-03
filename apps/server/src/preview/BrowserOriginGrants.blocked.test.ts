import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { makeTestBrowserOriginGrants } from "./BrowserOriginGrants.testkit.ts";

const input = {
  threadId: ThreadId.make("thread:one"),
  pid: 42,
  windowId: 7,
  origin: "https://example.test",
  windowTitle: "Browser",
};

it.effect("blocked origins cannot be requested, claimed, or approved after settings change", () =>
  Effect.gen(function* () {
    let hosts = ["example.test"];
    let published = 0;
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      blockedHosts: Effect.sync(() => hosts),
      publish: () =>
        Effect.sync(() => {
          published++;
        }),
      bind: () => Effect.die("blocked request must not bind"),
    });
    const request = yield* service.request(input);
    assert.equal(request.status === "refused" && request.code, "blocked_url");
    const claim = yield* service.claim(input);
    assert.equal(claim.agentResult.status === "refused" && claim.agentResult.code, "blocked_url");
    hosts = [];
    const pending = yield* service.request(input);
    if (pending.status !== "pending") return assert.fail("expected pending");
    hosts = ["example.test"];
    const answer = yield* service.answer(pending.claimId, true);
    assert.equal(answer.agentResult.status === "refused" && answer.agentResult.code, "blocked_url");
    assert.equal(published, 0);
    assert.deepEqual(yield* service.list(input.threadId), { claims: [], grants: [] });
  }),
);

it.effect("a blocked active tab declines to the agent and rolls back its grant", () =>
  Effect.gen(function* () {
    const published: Array<ReadonlyArray<string>> = [];
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      blockedHosts: Effect.succeed(["blocked.test"]),
      publish: (union) =>
        Effect.sync(() => {
          published.push(union.origins);
        }),
      bind: () =>
        Effect.succeed({
          targetId: "target-1",
          tabId: "tab",
          title: "Site",
          url: "https://blocked.test/private",
          driverGeneration: 1,
        }),
    });
    const answer = yield* service.claim(input);
    assert.equal(answer.agentResult.status === "refused" && answer.agentResult.code, "declined");
    assert.include("personMessage" in answer ? (answer.personMessage ?? "") : "", "blocked_url");
    assert.deepEqual(yield* service.list(input.threadId), { claims: [], grants: [] });
    assert.deepEqual(published.at(-1), []);
  }),
);

it.effect("a previously granted origin is not republished after it becomes blocked", () =>
  Effect.gen(function* () {
    let hosts: ReadonlyArray<string> = [];
    const published: Array<ReadonlyArray<string>> = [];
    const service = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      blockedHosts: Effect.sync(() => hosts),
      publish: (union) =>
        Effect.sync(() => {
          published.push(union.origins);
        }),
      bind: (request) =>
        Effect.succeed({
          targetId: "target",
          tabId: `tab-${request.windowId}`,
          title: "Site",
          url: request.origin,
          driverGeneration: 1,
        }),
    });
    const first = yield* service.claim(input);
    assert.equal(first.agentResult.status, "attached");
    hosts = ["example.test"];
    const second = yield* service.claim({ ...input, windowId: 8, origin: "https://other.test" });
    assert.equal(second.agentResult.status, "attached");
    assert.notInclude(published.at(-1) ?? [], "https://example.test");
  }),
);
