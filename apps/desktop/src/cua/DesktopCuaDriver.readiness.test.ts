import { assert, describe, it } from "@effect/vitest";
import { computerUseReady } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { afterEach, vi } from "vite-plus/test";

import {
  fixture,
  healthyTools,
  HELPER_ID,
  HELPER_PID,
  helperTools,
  toolResult,
} from "./DesktopCuaDriver.testkit.ts";

afterEach(() => vi.unstubAllEnvs());

const helperFixtureTools = (platform: "darwin" | "win32") =>
  platform === "win32"
    ? { ...healthyTools(), check_permissions: toolResult({ elevated: false, uia: true }) }
    : helperTools({ bundle: HELPER_ID, parent: HELPER_PID });
const helperFixture = (platform: "darwin" | "win32") =>
  fixture({ platform, helper: { granted: true }, tools: helperFixtureTools(platform) });

describe("DesktopCuaDriver readiness after a passing check", () => {
  it.effect.each(["darwin", "win32"] as const)(
    "shows what the checked helper can watch right after the check, before any agent turn, on %s",
    (platform) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* helperFixture(platform);
          assert.isTrue((yield* test.verify).verified);
          // The check started the helper, whose hello said it watches for a secure field (#1532).
          assert.equal(test.readiness.at(-1)?.signals.privateMode, "supported");
          // This desktop answers app listing requests, so the server may ask it (#1567).
          assert.isTrue(test.readiness.at(-1)?.appsListing);
        }),
      ),
  );

  it.effect.each(["darwin", "win32"] as const)(
    "keeps the running helper's own signals when a check fails before replacing it, on %s",
    (platform) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({
            platform,
            helper: { granted: true },
            helperWithoutWatch: true,
            tools: helperFixtureTools(platform),
          });
          yield* test.request("agent");
          assert.equal((yield* test.next).status, "ready");
          assert.equal(test.readiness.at(-1)?.signals.privateMode, "unsupported");
          // A newer build answers the check's probe, and the check stops at its grants: the
          // helper without watch keeps running, so nothing may say it watches.
          yield* test.answerAsHelper({ granted: false, canWatch: true });
          assert.isFalse((yield* test.verify).verified);
          assert.equal(test.readiness.at(-1)?.signals.privateMode, "unsupported");
        }),
      ),
  );

  it.effect.each(["darwin", "win32"] as const)(
    "stops claiming what a helper can watch once a later start cannot use it, on %s",
    (platform) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* helperFixture(platform);
          assert.isTrue((yield* test.verify).verified);
          assert.equal(test.readiness.at(-1)?.signals.privateMode, "supported");
          // Unattended admission reads this signal; a helper nobody can start watches nothing.
          yield* test.answerAsHelper({ granted: true, fails: new Error("bundle_mismatch") });
          yield* test.request("mismatch");
          assert.equal((yield* test.next).status, "unavailable");
          assert.equal(test.readiness.at(-1)?.signals.privateMode, "unsupported");
        }),
      ),
  );

  it.effect.each(["darwin", "win32"] as const)(
    "drops an earlier check's proof when a later start cannot use the helper on %s",
    (platform) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* helperFixture(platform);
          assert.isTrue((yield* test.verify).verified);
          const proven = test.readiness.at(-1)?.readiness;
          assert.isTrue(proven ? computerUseReady(proven) : false);

          // The helper's identity no longer matches when the next agent asks for it.
          yield* test.answerAsHelper({ granted: true, fails: new Error("bundle_mismatch") });
          yield* test.request("mismatch");
          assert.equal((yield* test.next).status, "unavailable");
          const after = test.readiness.at(-1)?.readiness;
          assert.equal(after?.helper, "unauthenticated");
          assert.equal(after?.capture, "pending");
          assert.isFalse(after ? computerUseReady(after) : true);
        }),
      ),
  );

  it.effect.each(["darwin", "win32"] as const)(
    "drops an earlier check's proof when the running helper exits unexpectedly on %s",
    (platform) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* helperFixture(platform);
          assert.isTrue((yield* test.verify).verified);
          yield* test.request("agent");
          assert.equal((yield* test.next).status, "ready");
          const running = test.readiness.at(-1)?.readiness;
          assert.isTrue(running ? computerUseReady(running) : false);

          const crash = yield* test.nextAgentCrash;
          yield* crash;
          assert.equal((yield* test.next).status, "unavailable");
          const after = test.readiness.at(-1)?.readiness;
          assert.equal(after?.helper, "unauthenticated");
          assert.isFalse(after ? computerUseReady(after) : true);
        }),
      ),
  );

  it.effect.each(["darwin", "win32"] as const)(
    "keeps a crash's lost proof when the host is detached right after it on %s",
    (platform) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* helperFixture(platform);
          assert.isTrue((yield* test.verify).verified);
          yield* test.request("agent");
          assert.equal((yield* test.next).status, "ready");

          const crash = yield* test.nextAgentCrash;
          // The exit is seen, but the owner goes away before the crash is handled, so retiring
          // the host takes the lock first.
          yield* crash;
          yield* test.request("detach", false);
          yield* test.request("replacement");
          const detached = yield* test.next;
          assert.equal(detached.requestId, "detach");
          assert.equal(detached.status, "stopped");
          const replacement = yield* test.next;
          assert.equal(replacement.requestId, "replacement");
          assert.equal(replacement.status, "ready");
          const after = test.readiness.at(-1)?.readiness;
          assert.equal(after?.capture, "pending");
          assert.isFalse(after ? computerUseReady(after) : true);
        }),
      ),
  );

  it.effect.each(["darwin", "win32"] as const)(
    "keeps a newer check's proof after retiring a crashed agent on %s",
    (platform) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* helperFixture(platform);
          assert.isTrue((yield* test.verify).verified);
          yield* test.request("agent");
          assert.equal((yield* test.next).status, "ready");
          const crash = yield* test.nextAgentCrash;
          yield* crash;
          assert.isTrue((yield* test.verify).verified);
          assert.equal((yield* test.next).status, "stopped");
          yield* test.request("replacement");
          assert.equal((yield* test.next).status, "ready");
          const after = test.readiness.at(-1)?.readiness;
          assert.isTrue(after ? computerUseReady(after) : false);
        }),
      ),
  );

  it.effect.each([
    { platform: "darwin", action: "detach" },
    { platform: "darwin", action: "restart" },
    { platform: "win32", action: "detach" },
    { platform: "win32", action: "restart" },
  ] as const)(
    "keeps a check's proof through an intentional stop on $platform ($action)",
    ({ platform, action }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* helperFixture(platform);
          assert.isTrue((yield* test.verify).verified);
          yield* test.request("agent");
          assert.equal((yield* test.next).status, "ready");
          yield* test.nextAgentCrash.pipe(Effect.asVoid);
          yield* action === "detach" ? test.request("detach", false) : test.restart;
          assert.equal((yield* test.next).status, "stopped");
          const idle = test.readiness.at(-1)?.readiness;
          assert.equal(idle?.helper, "authenticated");
          assert.isTrue(idle ? computerUseReady(idle) : false);
          yield* test.request("replacement");
          assert.equal((yield* test.next).status, "ready");
          const after = test.readiness.at(-1)?.readiness;
          assert.isTrue(after ? computerUseReady(after) : false);
        }),
      ),
  );
});

describe("macOS readiness transport", () => {
  it.effect("reads readiness over the helper MCP child without opening a socket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* helperFixture("darwin");
        assert.isTrue((yield* test.verify).verified);
        assert.equal(test.socketConnections(), 0);
        assert.deepEqual(
          test.helperLaunches.map(({ verify }) => verify),
          [true],
        );
        const ready = test.readiness.at(-1)?.readiness;
        assert.equal(ready?.helper, "authenticated");
        assert.isTrue(ready ? computerUseReady(ready) : false);
      }),
    ),
  );

  it.effect.each([
    { path: "a capture that works", after: "get_window_state", tools: {} },
    {
      path: "no GOAT window",
      after: "list_windows",
      tools: { list_windows: toolResult({ windows: [] }) },
    },
    {
      path: "no screenshot",
      after: "get_window_state",
      tools: { get_window_state: toolResult({ element_count: 3 }) },
    },
  ])(
    "refuses an authenticated helper whose identity is withdrawn after the identity check ($path)",
    ({ after, tools }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({
            platform: "darwin",
            helper: { granted: true },
            withdrawIdentityAfter: after,
            tools: { ...helperTools({ bundle: HELPER_ID, parent: HELPER_PID }), ...tools },
          });
          const result = yield* test.verify;
          assert.isFalse(result.verified);
          assert.equal(result.steps.at(-1)?.id, "identity");
          assert.isFalse(result.steps.at(-1)?.ok);
          assert.notEqual(test.readiness.at(-1)?.readiness.helper, "authenticated");
        }),
      ),
  );

  it.effect("refuses authenticated readiness when the driver is not the MCP service's child", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({
          platform: "darwin",
          helper: { granted: true },
          tools: helperTools({ bundle: HELPER_ID, parent: HELPER_PID + 1 }),
        });
        const result = yield* test.verify;
        assert.isFalse(result.verified);
        assert.equal(result.steps.at(-1)?.id, "identity");
        assert.isFalse(result.steps.at(-1)?.ok);
        assert.notEqual(test.readiness.at(-1)?.readiness.helper, "authenticated");
      }),
    ),
  );
});
