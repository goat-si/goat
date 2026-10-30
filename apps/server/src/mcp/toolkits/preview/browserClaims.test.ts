import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { BrowserOriginGrants } from "../../../preview/BrowserOriginGrantsLayer.ts";
import { makeTestBrowserOriginGrants } from "../../../preview/BrowserOriginGrants.testkit.ts";
import * as BrowserClaims from "./browserClaims/handlers.ts";
import { BrowserClaimToolkit } from "./browserClaims/tools.ts";

it.effect("agent request only creates pending approval and never binds or grants", () =>
  Effect.gen(function* () {
    let binds = 0;
    const grants = yield* makeTestBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.void,
      windowTitle: () => Effect.succeed("Observed browser"),
      bind: (input) =>
        Effect.sync(() => {
          binds++;
          return { tabId: "tab", title: "Site", url: input.origin, driverGeneration: 1 };
        }),
    });
    const threadId = ThreadId.make("thread:one");
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:test"),
      requestNamespace: "session:one",
      thread: {
        threadId,
        providerSessionId: "session:one",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(),
      issuedAt: 0,
    };
    const pending = yield* BrowserClaims.requestClaim({
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
    }).pipe(
      Effect.provideService(BrowserOriginGrants, {
        ...grants,
        setDriverCapability: () => Effect.void,
      }),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    );
    assert.equal(pending.status, "pending");
    assert.notInclude(JSON.stringify(pending), "Observed browser");
    assert.notInclude(JSON.stringify(pending), "example.test");
    assert.equal(binds, 0);
    assert.deepEqual((yield* grants.list(threadId)).grants, []);
    if (pending.status !== "pending") return assert.fail("expected pending");
    const answer = yield* grants.answer(pending.claimId, true);
    assert.equal(answer.agentResult.status, "attached");
    const own = yield* BrowserClaims.listClaims().pipe(
      Effect.provideService(BrowserOriginGrants, {
        ...grants,
        setDriverCapability: () => Effect.void,
      }),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    );
    assert.lengthOf(own.grants, 1);
    assert.lengthOf(own.claims, 1);
    const other = {
      ...scope,
      thread: {
        threadId: ThreadId.make("thread:other"),
        providerSessionId: "session:one",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    };
    const listed = yield* BrowserClaims.listClaims().pipe(
      Effect.provideService(BrowserOriginGrants, {
        ...grants,
        setDriverCapability: () => Effect.void,
      }),
      Effect.provideService(McpInvocationContext.McpInvocationContext, other),
    );
    assert.deepEqual(listed, { claims: [], grants: [] });
  }),
);

it("exposes request and list only, with no person approval mutations", () => {
  assert.deepEqual(Object.keys(BrowserClaimToolkit.tools).sort(), [
    "goat_browser_claim_list",
    "goat_browser_claim_request",
  ]);
});
