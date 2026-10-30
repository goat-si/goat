import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Bind from "./BrowserClaimBind.ts";
import { makeBrowserOriginGrants } from "./BrowserOriginGrants.ts";

it.effect("binds the active tab through a host-authorized scoped primitive", () =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const bind = yield* Bind.makeBrowserClaimBind({
      request: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return {
            status: "settled",
            driverGeneration: 1,
            result: {
              structuredContent: {
                mode: "bind",
                tabs: [
                  { tab_id: "tab", active: true, title: "Site", url: "https://example.test/page" },
                ],
              },
            },
          };
        }),
    });
    const result = yield* bind({
      claimId: "claim:1",
      bindingVersion: 1,
      threadId: ThreadId.make("thread:one"),
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    assert.deepEqual(result, {
      tabId: "tab",
      title: "Site",
      url: "https://example.test/page",
      driverGeneration: 1,
    });
    assert.lengthOf(calls, 1);
    assert.deepInclude(calls[0], {
      authority: "claimBind",
      tool: "get_browser_state",
      args: {
        pid: 42,
        window_id: 7,
        origin_scope: ["https://example.test"],
        session: "goat-claim:claim:1",
      },
    });
  }),
);

it.effect("a redacted active tab produces the identical decline and revokes the new grant", () =>
  Effect.gen(function* () {
    const hash = "a".repeat(64);
    let calls = 0;
    const bind = yield* Bind.makeBrowserClaimBind({
      request: () =>
        Effect.sync(() => {
          calls++;
          return {
            status: "settled",
            driverGeneration: 1,
            result: {
              structuredContent: { mode: "bind", tabs: [{ tab_id: "hidden", active: true }] },
            },
          };
        }),
    });
    const threadId = ThreadId.make("thread:one");
    const grants = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.succeed(hash),
      confirm: () =>
        Effect.succeed({
          capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null },
        }),
      bind,
    });
    const input = {
      threadId,
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    };
    const first = yield* grants.request(input);
    if (first.status !== "pending") return assert.fail("expected pending");
    assert.equal(calls, 0);
    const decline = yield* grants.answer(first.claimId, false);
    const second = yield* grants.request(input);
    if (second.status !== "pending") return assert.fail("expected pending");
    const denied = yield* grants.answer(second.claimId, true);
    assert.equal(JSON.stringify(denied.agentResult), JSON.stringify(decline.agentResult));
    assert.deepEqual((yield* grants.list(threadId)).grants, []);
    assert.equal(calls, 1);
  }),
);

it.effect(
  "reads the pending card title from the selected window and rejects a missing window",
  () =>
    Effect.gen(function* () {
      const requests: unknown[] = [];
      const title = yield* Bind.makeBrowserClaimWindow({
        request: (input) =>
          Effect.sync(() => {
            requests.push(input);
            return {
              status: "settled",
              result: {
                structuredContent: {
                  windows: [{ pid: 42, window_id: 7, title: "Observed browser" }],
                },
              },
            };
          }),
      });
      const target = { threadId: ThreadId.make("thread:one"), pid: 42, windowId: 7 };
      assert.equal(yield* title(target), "Observed browser");
      assert.deepInclude(requests[0], { tool: "list_windows", args: { pid: 42 } });
      const missing = yield* title({ ...target, windowId: 8 }).pipe(Effect.result);
      assert.equal(missing._tag, "Failure");
    }),
);
