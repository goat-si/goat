import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ProviderUsageLimitsReport } from "@goat/provider-core/server/snapshot";
import type { MuseSubscriptionUsage } from "./protocol.ts";

import {
  testLayer,
  INSTANCE_ID,
  runtimePolicy,
  makeFakeMuse,
  makeHarness,
  startConversation,
} from "./test/adapterHelpers.ts";

const SUBSCRIPTION_USAGE = {
  window: { usedPercent: 0, windowDurationMins: 300, resetsAtMs: 1791465557000 },
  weekly: { usedPercent: 5, resetsAtMs: 1791763200000 },
  tier: "tier-1",
  observedAtMs: 1791447762610,
} satisfies MuseSubscriptionUsage;
const QUOTA_MESSAGE =
  "API error 429: Subscription quota exhausted. Your usage window resets soon. (rate_limit_error)";

describe("MuseAdapterV2", () => {
  it.effect("stops at a Meta usage limit until every exhausted window resets", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const reports: Array<ProviderUsageLimitsReport> = [];
      const harness = yield* makeHarness(
        fake,
        INSTANCE_ID,
        undefined,
        undefined,
        undefined,
        runtimePolicy,
        { onUsageLimits: (report) => Effect.sync(() => void reports.push(report)) },
      );
      yield* fake.emitHostWide("usage/changed", {
        ...SUBSCRIPTION_USAGE,
        window: { ...SUBSCRIPTION_USAGE.window, usedPercent: 103 },
      });
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", {
        turnId: nativeId,
        terminal: "failed",
        reason: QUOTA_MESSAGE,
        error: { kind: "modelError", message: QUOTA_MESSAGE, retryable: false },
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "failed");
      assert.strictEqual(terminal.threadDisposition, "reusable");
      assert.strictEqual(terminal.failure?.class, "usage_limit");
      assert.strictEqual(terminal.failure?.resetAt, "2026-10-08T13:19:17.000Z");
      assert.deepStrictEqual(
        reports.map((report) => [report.authLabel, report.windows[0]?.usedPercent]),
        [["tier-1", 100]],
      );
      assert.isTrue(
        harness.allEvents.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.title === "Usage limit reached",
        ),
      );

      const next = yield* startConversation(harness, fake, 2);
      yield* fake.emit("turn/completed", {
        turnId: next.nativeId,
        terminal: "failed",
        error: { message: "API error 429: Rate limit exceeded. (rate_limit_error)" },
      });
      const throttled = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(throttled.failure?.class, "provider_error");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("skips an unreadable usage report without ending the session", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const reports: Array<ProviderUsageLimitsReport> = [];
      const harness = yield* makeHarness(
        fake,
        INSTANCE_ID,
        undefined,
        undefined,
        undefined,
        runtimePolicy,
        { onUsageLimits: (report) => Effect.sync(() => void reports.push(report)) },
      );
      yield* fake.emitHostWide("usage/changed", { window: "not usage" });
      yield* fake.emitHostWide("usage/changed", {
        ...SUBSCRIPTION_USAGE,
        window: { ...SUBSCRIPTION_USAGE.window, usedPercent: 103, resetsAtMs: 1e16 },
      });
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", {
        turnId: nativeId,
        terminal: "failed",
        error: { message: QUOTA_MESSAGE },
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.failure?.class, "usage_limit");
      assert.isUndefined(terminal.failure?.resetAt);
      assert.deepStrictEqual(reports, []);
      assert.strictEqual(fake.closeCount(), 0);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
