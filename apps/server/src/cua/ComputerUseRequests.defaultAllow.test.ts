import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { threadId, withHarness } from "../handoffs/Handoffs.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import { sessionId, supported, withRequests } from "./ComputerUseRequests.testkit.ts";

const strictOff = Effect.gen(function* () {
  yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
    cuaStrictInputGuards: false,
    cuaAllowedApps: ["com.example.Editor"],
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

it.effect("strict-off does not reuse a live grant after its control stops", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        const first = yield* request({ apps: ["com.example.Editor"] });
        if (first.kind !== "needs_human") return assert.fail("expected strict-mode approval");
        yield* handoffs.respond(
          { threadId, handoffId: first.handoff.handoffId, action: "completed" },
          sessionId,
        );
        yield* settings.updateSettings({ cuaStrictInputGuards: false });
        const runId = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!.id;
        Option.getOrThrow(yield* leases.control(threadId, Option.none(), runId));
        assert.isTrue(yield* leases.stop(threadId));
        assert.deepInclude(yield* request({ apps: ["com.example.Editor"] }), {
          kind: "refused",
          reason: "interrupted",
        });
        const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
        assert.equal(records.turnItems.filter((item) => item.type === "human_handoff").length, 1);
      }),
    ),
  ),
);

it.effect("strict-off does not recreate a standing approval handoff", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
      Effect.gen(function* () {
        const first = yield* request({ apps: ["com.example.Editor"] });
        if (first.kind !== "needs_human") return assert.fail("expected strict-mode approval");
        yield* handoffs.respond(
          {
            threadId,
            handoffId: first.handoff.handoffId,
            action: "completed",
            computerUseScope: "always",
          },
          sessionId,
        );
        yield* leases.release([first.handoff.handoffId]);
        yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
          cuaStrictInputGuards: false,
        });
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
        const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
        assert.equal(records.turnItems.filter((item) => item.type === "human_handoff").length, 1);
      }),
    ),
  ),
);

it.effect.each(["pause", "takeover"] as const)(
  "strict-off refuses background and foreground requests during %s",
  (interruption) =>
    withHarness(({ orchestrator }) =>
      withRequests(orchestrator, supported, ({ request, leases }) =>
        Effect.gen(function* () {
          yield* strictOff;
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
          const control = Option.getOrThrow(yield* leases.currentControl(threadId));
          if (interruption === "pause") yield* leases.pause("screen_locked");
          else yield* leases.hold(control.controlId, true);
          for (const input of [{ apps: ["com.example.Editor"] }, { foreground: true }])
            assert.deepInclude(yield* request(input), {
              kind: "refused",
              reason: "interrupted",
            });
        }),
      ),
    ),
);

it.effect("strict-off reuses an attached control without clearing its live cursor", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, leases }) =>
      Effect.gen(function* () {
        yield* strictOff;
        yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
          cuaAllowedApps: [],
        });
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
        const control = Option.getOrThrow(yield* leases.currentControl(threadId));
        assert.isTrue(
          yield* leases.setTarget(threadId, control.controlId, { pid: 42, windowId: 7 }),
        );
        const cursor = { windowId: 7, point: { fx: 0.25, fy: 0.5 }, phase: "acting" } as const;
        assert.isTrue(yield* leases.setTarget(threadId, control.controlId, { cursor }));
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
        assert.deepEqual(Option.getOrThrow(yield* leases.currentControl(threadId)).cursor, cursor);
      }),
    ),
  ),
);

it.effect("strict-off can be restored after a strict-on revocation in the same run", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, leases }) =>
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient)`UPDATE orchestration_v2_projection_threads
          SET runtime_mode = 'approval-required' WHERE thread_id = ${threadId}`;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ cuaStrictInputGuards: false });
        const initial = yield* request({ apps: ["com.example.Editor"] });
        assert.isFalse((yield* settings.getSettings).cuaStrictInputGuards);
        const current = Option.getOrThrow(yield* leases.currentControl(threadId));
        assert.equal(
          (yield* leases.controlState(threadId, current.controlId))._tag,
          "active",
          JSON.stringify(current),
        );
        assert.equal(initial.kind, "available", JSON.stringify(initial));
        yield* settings.updateSettings({ cuaStrictInputGuards: true });
        assert.deepEqual(yield* leases.controlState(threadId, current.controlId), {
          _tag: "ended",
          reason: "revoked",
        });
        yield* settings.updateSettings({ cuaStrictInputGuards: false });
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
      }),
    ),
  ),
);
