import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProviderInstanceConfigMap, ServerProvider } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { builtInCodexWiring, localOpenCodexRoutes } from "./localRoutes.ts";
import { parityVerdict } from "./parity.ts";
import { fleetSnapshot } from "./parity.testkit.ts";

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

it.effect("a join whose new link was replaced during the join is not reported linked", () =>
  Effect.gen(function* () {
    const hub = yield* setup({
      pin: PINNED,
      replacedAfterAdd: "lnk_aaaaaaaaaaaaaaaa",
    });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mac-studio" });
    expect(result.state).toBe("degraded");
    expect(result.message).toContain("changed during the join");
  }),
);

it.effect("a join whose new link is gone from the Home record is not reported linked", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ pin: PINNED, removedAfterAdd: true });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mac-studio" });
    expect(result.state).toBe("degraded");
    expect(result.message).toContain("could not confirm");
  }),
);

it.effect("after a join the repair ladder syncs exactly as on dev: once, only for P6 or P7", () =>
  Effect.gen(function* () {
    // dev ef6c578913 HubMembership.ts:227-271 with hubLadder.ts:7-10: sync rung on P6/P7 via ocx.device.
    const failingP6 = yield* setup({ pin: PINNED, verdicts: [verdict(["P6"]), verdict()] });
    yield* failingP6.membership.join(scope, { deviceAlias: "mac-studio" });
    expect(failingP6.calls.filter((call) => call.includes("sync"))).toEqual([
      "device mac-studio sync",
    ]);
    const clean = yield* setup({ pin: PINNED });
    yield* clean.membership.join(scope, { deviceAlias: "mac-studio" });
    expect(clean.calls.filter((call) => call.includes("sync"))).toEqual([]);
  }),
);

it.effect(
  "a join whose routing is not shown says so and tells failed from unproven: repair can interrupt a turn, or changes nothing",
  () =>
    Effect.gen(function* () {
      const unproven = {
        verdict: "unproven" as const,
        checkedAt: 0,
        failingCheckIds: [],
        checks: [{ id: "P7" as const, status: "unproven" as const, reason: "fixture" }],
      };
      const linked = yield* setup({ pin: PINNED, verdicts: [unproven] });
      const child = yield* linked.membership.join(scope, { deviceAlias: "mac-studio" });
      expect(child.state).toBe("child");
      expect(child.message).toContain("cannot yet show mac-studio routing through this Home");
      expect(child.message).toContain("changes nothing for an unproven check");
      expect(child.message).not.toContain("interrupt");
      const failing = yield* setup({ pin: PINNED, verdicts: [verdict(["P6"])] });
      const degraded = yield* failing.membership.join(scope, { deviceAlias: "mac-studio" });
      expect(degraded.state).toBe("degraded");
      expect(degraded.message).toContain("it can interrupt a turn running there");
    }),
);

const decodeInstances = Schema.decodeUnknownSync(ProviderInstanceConfigMap);
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
/** A Child whose Claude routes through local OpenCodex and whose built-in Codex routes natively. */
const nativeBuiltInCodex = () => {
  const instances = decodeInstances({
    claude: {
      driver: "claudeAgent",
      environment: [{ name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:10100" }],
    },
  });
  const providers = [
    decodeProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "fixture",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-11T00:00:00.000Z",
      models: [],
      codexRoute: { modelRoute: "default", effectiveBaseUrl: "https://api.openai.com/v1" },
    }),
  ];
  const device = fleetSnapshot("mac-studio");
  const evidence = device.parityEvidence;
  if (evidence === undefined) throw new Error("fixture has parity evidence");
  const verdictWith = (
    wiring: ReadonlyArray<{ status: "ok" | "failed" | "unproven"; reason: string }>,
  ) =>
    parityVerdict({
      deviceAlias: "mac-studio",
      checkedAt: 0,
      home: fleetSnapshot("home"),
      device: {
        ...device,
        parityEvidence: {
          ...evidence,
          wiring: wiring.map(({ status, reason }) => ({ status, reason })),
        },
      },
    });
  const configured = localOpenCodexRoutes({ instances, providers, environment: {}, port: 10100 });
  return {
    // What dev's parity read: settings entries only.
    dev: verdictWith(configured),
    now: verdictWith([...configured, ...builtInCodexWiring({ instances, providers, port: 10100 })]),
  };
};

it.effect(
  "a built-in Codex routing natively is reported but never triggers the join's sync on a busy Child",
  () =>
    Effect.gen(function* () {
      const { now } = nativeBuiltInCodex();
      const hub = yield* setup({ pin: PINNED, running: 1, verdicts: [now] });
      const result = yield* hub.membership.join(scope, { deviceAlias: "mac-studio" });
      expect(hub.calls.filter((call) => call.includes("sync"))).toEqual([]);
      expect(result.message).toContain("P7");
    }),
);

it.effect("the post-join sync trigger for built-in Codex evidence equals dev's", () =>
  Effect.sync(() => {
    const { dev, now } = nativeBuiltInCodex();
    const syncTrigger = (ids: ReadonlyArray<string>) =>
      ids.filter((id) => id === "P6" || id === "P7");
    expect(syncTrigger(now.failingCheckIds)).toEqual(syncTrigger(dev.failingCheckIds));
    expect(now.checks.find(({ id }) => id === "P7")?.status).not.toBe("ok");
  }),
);
