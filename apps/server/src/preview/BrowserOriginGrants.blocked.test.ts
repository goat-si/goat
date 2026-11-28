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

it.effect(
  "admitClaimCall and judgeClaimCall refuse non-web schemes and resolve relative URLs against tab origin",
  () =>
    Effect.gen(function* () {
      const blockedHosts = ["blocked.test"];
      const service = yield* makeTestBrowserOriginGrants({
        environmentId: EnvironmentId.make("environment:test"),
        supported: () => true,
        blockedHostsNow: () => blockedHosts,
        publish: () => Effect.void,
        bind: (request) =>
          Effect.succeed({
            targetId: "target-1",
            tabId: "tab-1",
            title: "Site",
            url: request.origin,
            driverGeneration: 1,
          }),
      });
      const claimed = yield* service.claim(input);
      if (claimed.agentResult.status !== "attached") return assert.fail("expected attached");
      const claim = claimed.agentResult.claim;
      const baseArgs = {
        tab_id: "tab-1",
        target_id: "target-1",
        session: `goat-claim:${claim.claimId}`,
        origin_scope: ["https://example.test"],
      };
      const relativeAllowed = yield* service.admitClaimCall(
        input.threadId,
        "browser_navigate",
        { ...baseArgs, url: "/dashboard" },
        blockedHosts,
      );
      assert.equal(relativeAllowed.status, "admit");
      const relativeBlocked = yield* service.admitClaimCall(
        input.threadId,
        "browser_navigate",
        { ...baseArgs, url: "//blocked.test/private" },
        blockedHosts,
      );
      assert.equal(relativeBlocked.status, "blocked");
      const judgeBlocked = yield* service.judgeClaimCall(input.threadId, "browser_navigate", {
        ...baseArgs,
        url: "//blocked.test/private",
      });
      assert.equal(judgeBlocked, "blocked");
      for (const badUrl of [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "data:text/html,hi",
        "file:///etc/passwd",
        "chrome://settings",
        "blob:https://example.test/1234",
      ]) {
        const admitted = yield* service.admitClaimCall(
          input.threadId,
          "browser_navigate",
          { ...baseArgs, url: badUrl },
          blockedHosts,
        );
        assert.equal(admitted.status, "outside");
        const judged = yield* service.judgeClaimCall(input.threadId, "browser_navigate", {
          ...baseArgs,
          url: badUrl,
        });
        assert.equal(judged, "outside");
      }
    }),
);
