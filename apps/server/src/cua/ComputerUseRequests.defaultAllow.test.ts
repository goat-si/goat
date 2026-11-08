import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { threadId, withHarness } from "../handoffs/Handoffs.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import { supported, withRequests } from "./ComputerUseRequests.testkit.ts";

const strictOff = Effect.gen(function* () {
  yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
    cuaStrictInputGuards: false,
  });
});

it.effect("strict-off admits an ordinary app without a handoff", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request }) =>
      Effect.gen(function* () {
        yield* strictOff;
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
        const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
        assert.isFalse(records.turnItems.some((item) => item.type === "human_handoff"));
      }),
    ),
  ),
);

it.effect.each(["schedule", "remote"] as const)(
  "strict-off admits a protected app from an unattended %s origin without a handoff",
  (from) =>
    withHarness(({ orchestrator }) =>
      withRequests(
        orchestrator,
        supported,
        ({ request }) =>
          Effect.gen(function* () {
            yield* strictOff;
            assert.equal((yield* request({ apps: ["com.1password.1password"] })).kind, "available");
            const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
            assert.isFalse(records.turnItems.some((item) => item.type === "human_handoff"));
          }),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        from,
        undefined,
        [{ id: "com.1password.1password", name: "1Password" }],
      ),
    ),
);

it.effect("strict-off admits unattended foreground and an app launch without a handoff", () =>
  withHarness(({ orchestrator }) =>
    withRequests(
      orchestrator,
      supported,
      ({ request, leases }) =>
        Effect.gen(function* () {
          yield* strictOff;
          assert.equal((yield* request({ foreground: true })).kind, "available");
          assert.isTrue(yield* leases.foregroundAvailable(threadId, "Open the protected app"));
          assert.equal(
            (yield* request({
              apps: ["com.1password.1password"],
              foreground: true,
              purpose: "Open the protected app",
            })).kind,
            "available",
          );
          const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
          assert.isFalse(records.turnItems.some((item) => item.type === "human_handoff"));
        }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "remote",
      undefined,
      [{ id: "com.1password.1password", name: "1Password" }],
    ),
  ),
);

it.effect("strict-on keeps ordinary and foreground requests behind approval", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request }) =>
      Effect.gen(function* () {
        yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
          cuaStrictInputGuards: true,
        });
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
        assert.equal((yield* request({ foreground: true })).kind, "needs_human");
      }),
    ),
  ),
);

it.effect.each(["background", "foreground"] as const)(
  "strict-off does not revive a stopped %s control or create a handoff",
  (kind) =>
    withHarness(({ orchestrator }) =>
      withRequests(orchestrator, supported, ({ request, leases }) =>
        Effect.gen(function* () {
          yield* strictOff;
          const input =
            kind === "foreground" ? { foreground: true } : { apps: ["com.example.Editor"] };
          assert.equal((yield* request(input)).kind, "available");
          assert.isTrue(yield* leases.stop(threadId));
          assert.deepInclude(yield* request(input), { kind: "refused", reason: "interrupted" });
          const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
          assert.isFalse(records.turnItems.some((item) => item.type === "human_handoff"));
        }),
      ),
    ),
);
