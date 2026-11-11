import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PINNED, scope, setup, verdict } from "./HubMembership.testkit.ts";

it.effect("a refused link add reports OpenCodex's own message", () =>
  Effect.gen(function* () {
    const message = "Remote Link failed during Child restart preflight";
    const hub = yield* setup({ pin: PINNED, addExit: { code: 1, message } });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mac-studio" });
    expect(result.state).toBe("failed");
    expect(result.message).toBe(`OpenCodex: ${message}`);
    expect(result.steps.find(({ step }) => step === "link_add")?.detail).toBe(
      `OpenCodex: ${message}`,
    );
  }),
);

it.effect("a refused Child restart names OpenCodex's reason in the leave step", () =>
  Effect.gen(function* () {
    const reason =
      "Restart not performed; the running client runtime was kept. Its background service owns it: run `ocx service restart`.";
    const hub = yield* setup({
      linked: ["mini"],
      deviceExit: { restart: 1 },
      deviceMessage: { restart: reason },
      reportedRole: "client",
    });
    const result = yield* hub.membership.leave(scope, { deviceAlias: "mini" });
    expect(result.steps.find(({ step }) => step === "restart")?.detail).toBe(
      `ocx restart exited 1: ${reason}`,
    );
  }),
);

it.effect("a leave whose restart is refused but whose device answers standalone ends ready", () =>
  Effect.gen(function* () {
    const hub = yield* setup({
      linked: ["mini"],
      deviceExit: { restart: 1 },
      reportedRole: "standalone",
      deviceHealthy: true,
    });
    const result = yield* hub.membership.leave(scope, { deviceAlias: "mini" });
    expect(result.state).toBe("ready");
    expect(hub.calls).toContain(
      "home link revoke --link-id lnk_0123456789abcdef --force --yes --json",
    );
  }),
);

it.effect("a refused restart without proof of standalone never revokes the link", () =>
  Effect.gen(function* () {
    const unproven = [
      { reportedRole: "client" as const, deviceHealthy: true },
      { reportedRole: "standalone" as const, deviceHealthy: false },
      { deviceHealthy: true },
    ];
    for (const evidence of unproven) {
      const hub = yield* setup({ linked: ["mini"], deviceExit: { restart: 1 }, ...evidence });
      const result = yield* hub.membership.leave(scope, { deviceAlias: "mini" });
      expect(result.state).toBe("needs_human");
      expect(hub.calls.some((call) => call.includes("link revoke"))).toBe(false);
    }
  }),
);

it.effect("a restart that timed out is not a refusal, so the link stays", () =>
  Effect.gen(function* () {
    const hub = yield* setup({
      linked: ["mini"],
      deviceExit: { restart: 124 },
      reportedRole: "standalone",
      deviceHealthy: true,
    });
    const result = yield* hub.membership.leave(scope, { deviceAlias: "mini" });
    expect(result.state).toBe("needs_human");
    expect(hub.calls.some((call) => call.includes("link revoke"))).toBe(false);
  }),
);

const LINK = "lnk_fedcba9876543210";

it.effect("join runs a guarded sync over the new link before verifying", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ pin: PINNED });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mac-studio" });
    const added = hub.calls.findIndex((call) => call.startsWith("home link add"));
    const synced = hub.calls.indexOf(`sync mac-studio ${LINK}`);
    expect(added).toBeGreaterThanOrEqual(0);
    expect(synced).toBeGreaterThan(added);
    expect(synced).toBeLessThan(hub.calls.indexOf("verify mac-studio"));
    expect(result.steps.find(({ step }) => step === "sync")?.outcome).toBe("ok");
  }),
);

it.effect("a busy device defers the join's sync, and the repair ladder does not sync either", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ pin: PINNED, running: 1, verdicts: [verdict(["P6"]), verdict()] });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mac-studio" });
    expect(hub.calls.filter((call) => call.includes("sync"))).toEqual([]);
    expect(
      result.steps.filter(({ step }) => step === "sync").map(({ outcome }) => outcome),
    ).toEqual(["deferred", "deferred"]);
  }),
);

it.effect("a connection that moved during the join's sync is reported, never as synced", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ pin: PINNED, syncExit: 91 });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mac-studio" });
    const sync = result.steps.find(({ step }) => step === "sync");
    expect(sync?.outcome).toBe("failed");
    expect(sync?.detail).toContain("changed");
    expect(result.state).toBe("degraded");
  }),
);

it.effect("a join whose parity is unproven says which checks are unproven", () =>
  Effect.gen(function* () {
    const unproven = {
      verdict: "unproven" as const,
      checkedAt: 0,
      failingCheckIds: [],
      checks: [{ id: "P7" as const, status: "unproven" as const, reason: "fixture" }],
    };
    const hub = yield* setup({ pin: PINNED, verdicts: [unproven] });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mac-studio" });
    expect(result.state).toBe("child");
    expect(result.message).toContain("Unproven: P7.");
  }),
);

it.effect("a guarded join sync that failed is not retried by the ladder's unguarded sync", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ pin: PINNED, syncExit: 91, verdicts: [verdict(["P6"]), verdict()] });
    yield* hub.membership.join(scope, { deviceAlias: "mac-studio" });
    expect(hub.calls).not.toContain("device mac-studio sync");
  }),
);

it.effect("after the join's guarded sync ran, the ladder never syncs again unguarded", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ pin: PINNED, verdicts: [verdict(["P7"]), verdict()] });
    yield* hub.membership.join(scope, { deviceAlias: "mac-studio" });
    expect(hub.calls.filter((call) => call.includes("sync"))).toEqual([
      "sync mac-studio lnk_fedcba9876543210",
    ]);
  }),
);

it.effect("a join whose new link was replaced before its sync is not reported linked", () =>
  Effect.gen(function* () {
    const hub = yield* setup({
      pin: PINNED,
      syncExit: 90,
      replacedDuringSync: "lnk_aaaaaaaaaaaaaaaa",
    });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mac-studio" });
    expect(result.state).toBe("degraded");
    expect(result.message).toContain("changed during the join");
  }),
);

it.effect("a join whose new link is gone from the Home record is not reported linked", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ pin: PINNED, removedDuringSync: true });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mac-studio" });
    expect(result.state).toBe("degraded");
    expect(result.message).toContain("could not confirm");
  }),
);
