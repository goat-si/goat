import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  BUILTIN_PERMISSION_PROFILES,
  EnvironmentId,
  type HubParityCheckId,
  type HubParityResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Inbox from "../goatclaw/DecisionInbox.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as PendingQuestions from "../mcp/PendingQuestionsMcpService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as HubMembership from "./HubMembership.ts";
import { HubOcx, HubOcxError, type OcxOutput } from "./HubOcx.ts";
import * as HubParity from "./HubParity.ts";

const PINNED = "SHA256:pinnedpinnedpinnedpinnedpinnedpinnedpinned0";
const OTHER = "SHA256:otherotherotherotherotherotherotherotherot0";
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("hub"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "hub-test",
  thread: undefined,
  client: { sessionId: "agent", label: "Agent", access: "full-access" },
};
const owner: Inbox.DecisionCaller = {
  kind: "client",
  sessionId: "person",
  environmentId: EnvironmentId.make("hub"),
  scopes: ["orchestration:operate", "settings:write"],
};
const verdict = (failing: ReadonlyArray<HubParityCheckId> = []): HubParityResult => ({
  verdict: failing.length === 0 ? "ok" : failing.some((id) => id <= "P4") ? "broken" : "degraded",
  checkedAt: 0,
  failingCheckIds: failing,
  checks: failing.map((id) => ({ id, status: "failed", reason: "fixture" })),
});

interface Fixture {
  readonly profile?: string;
  readonly pin?: string;
  readonly offered?: string;
  readonly direct?: boolean;
  readonly running?: number;
  readonly linked?: ReadonlyArray<string>;
  readonly verdicts?: ReadonlyArray<HubParityResult>;
  readonly addFails?: boolean;
  readonly deviceDown?: ReadonlyArray<string>;
  readonly deviceExit?: Readonly<Record<string, number>>;
  readonly health?: { readonly service: string; readonly role?: string };
  readonly strayTunnel?: boolean;
}

const setup = Effect.fn("HubMembershipTest.setup")(function* (fixture: Fixture = {}) {
  const calls: string[] = [];
  const links = new Map((fixture.linked ?? []).map((alias) => [alias, "lnk_0123456789abcdef"]));
  const verdicts = [...(fixture.verdicts ?? [])];
  let offered = fixture.offered ?? PINNED;
  const json = (value: unknown): OcxOutput => ({ code: 0, stdout: JSON.stringify(value) });
  const home = (args: ReadonlyArray<string>): Effect.Effect<OcxOutput, HubOcxError> => {
    calls.push(`home ${args.join(" ")}`);
    const [group, command, alias] = args;
    if (group === "link" && command === "status")
      return Effect.succeed(
        json({
          role: "home",
          links: [...links].map(([name, id]) => ({ id, alias: name, tunnelPort: 42255 })),
        }),
      );
    if (command === "probe")
      return Effect.succeed(json({ alias, fingerprint: offered, keyType: "ssh-ed25519" }));
    if (command === "add") {
      if (fixture.addFails)
        return Effect.succeed({ code: 1, stdout: "", phase: "child_relay_failed" });
      links.set(alias!, "lnk_fedcba9876543210");
      return Effect.succeed(json({ linkId: "lnk_fedcba9876543210" }));
    }
    if (command === "revoke") {
      for (const [name, id] of links) if (id === args[3]) links.delete(name);
      return Effect.succeed(json({ linkId: args[3] }));
    }
    return Effect.succeed(json({ linkId: args[3] }));
  };
  const device = (alias: string, args: ReadonlyArray<string>) => {
    calls.push(`device ${alias} ${args.join(" ")}`);
    return fixture.deviceDown?.includes(args[0]!)
      ? Effect.fail(new HubOcxError({ reason: "unreachable", message: `${alias} is down.` }))
      : Effect.succeed({ code: fixture.deviceExit?.[args[0]!] ?? 0, stdout: "opencodex 2.89.0" });
  };
  const goatclaw = {
    enabled: true,
    defaultProfile: fixture.profile ?? "owner",
    profiles: {
      ...BUILTIN_PERMISSION_PROFILES,
      "hub-admin": {
        id: "hub-admin",
        runtimeModeCeiling: "full-access" as const,
        capabilities: ["hub.manage" as const, "threads.launch" as const],
        maxLanes: 1,
      },
    },
  };
  const context = yield* Layer.build(
    HubMembership.layer.pipe(
      Layer.provide(
        Layer.succeed(
          HubOcx,
          HubOcx.of({
            home,
            device,
            pinnedFingerprint: () => Effect.succeed(fixture.pin),
            directAlias: () => Effect.succeed(fixture.direct ?? true),
            runningTurns: () => Effect.succeed(fixture.running ?? 0),
            deviceHealth: (alias) =>
              Effect.sync(() => {
                calls.push(`health ${alias}`);
                return JSON.stringify(fixture.health ?? { service: "opencodex" });
              }),
            homeTunnels: (alias, port) =>
              Effect.sync(() => {
                calls.push(`tunnels ${alias} ${port}`);
                return links.has(alias) || fixture.strayTunnel ? 1 : 0;
              }),
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(HubParity.HubParity)({
          verify: (alias) =>
            Effect.sync(() => {
              calls.push(`verify ${alias}`);
              return verdicts.length > 1 ? verdicts.shift()! : (verdicts[0] ?? verdict());
            }),
        }),
      ),
      Layer.provideMerge(Inbox.layer),
      Layer.provideMerge(Profiles.layer),
      Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
      Layer.provide(Layer.mock(PendingQuestions.PendingQuestionsMcpService)({})),
      Layer.provideMerge(Settings.layerTest({ goatclaw })),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provide(NodeCrypto.layer),
    ),
  );
  const membership = Context.get(context, HubMembership.HubMembership);
  const inbox = Context.get(context, Inbox.DecisionInbox);
  const sql = Context.get(context, SqlClient.SqlClient);
  const audit = sql<{
    action: string;
    target: string;
    outcome: string;
    decision_id: string | null;
  }>`SELECT action, target, outcome, decision_id FROM audit_events WHERE action LIKE 'hub.%' ORDER BY id`;
  return {
    membership,
    inbox,
    audit,
    calls,
    approve: (id: string, optionId = "approve") =>
      inbox.answer(owner, { id, optionId, reason: "Reviewed the host key." }),
    offer: (fingerprint: string) => {
      offered = fingerprint;
    },
  };
});

it.effect("an owner joins a pinned device: GOAT's pin becomes --expect-fingerprint", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ pin: PINNED });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mac-studio" });
    expect(result.state).toBe("child");
    expect(hub.calls).toEqual([
      "home link status --json",
      "device mac-studio --version",
      "home link probe mac-studio --json",
      `home link add mac-studio --expect-fingerprint ${PINNED} --json`,
      "verify mac-studio",
    ]);
    expect(yield* hub.audit).toEqual([
      { action: "hub.join", target: "mac-studio", outcome: "started", decision_id: null },
      { action: "hub.join", target: "mac-studio", outcome: "child", decision_id: null },
    ]);
  }),
);

it.effect("an unpinned key waits for a person, then joins with the approved key once", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ addFails: true });
    const first = yield* hub.membership.join(scope, { deviceAlias: "lidge-ts" });
    expect(first.state).toBe("needs_human");
    expect(hub.calls.some((call) => call.includes("link add"))).toBe(false);
    const item = yield* hub.inbox.get(owner, first.decisionId!);
    expect(item.requiredProfile).toBe("owner");
    expect(item.context).toContain(PINNED);

    const early = yield* hub.membership
      .join(scope, { deviceAlias: "lidge-ts", decisionId: first.decisionId! })
      .pipe(Effect.flip);
    expect(early.message).toContain("still open");

    yield* hub.approve(first.decisionId!);
    const second = yield* hub.membership.join(scope, {
      deviceAlias: "lidge-ts",
      decisionId: first.decisionId!,
    });
    expect(second.state).toBe("failed");
    expect(second.message).toContain("child_relay_failed");
    expect(hub.calls).toContain(`home link add lidge-ts --expect-fingerprint ${PINNED} --json`);

    const reused = yield* hub.membership
      .join(scope, { deviceAlias: "lidge-ts", decisionId: first.decisionId! })
      .pipe(Effect.flip);
    expect(reused.message).toContain("already used");
  }),
);

it.effect("an approval does not carry over to a different host key", () =>
  Effect.gen(function* () {
    const hub = yield* setup();
    const first = yield* hub.membership.join(scope, { deviceAlias: "lidge-ts" });
    yield* hub.approve(first.decisionId!);
    hub.offer(OTHER);
    const refused = yield* hub.membership
      .join(scope, { deviceAlias: "lidge-ts", decisionId: first.decisionId! })
      .pipe(Effect.flip);
    expect(refused.code).toBe("invalid_request");
    expect(hub.calls.some((call) => call.includes("link add"))).toBe(false);
  }),
);

it.effect("a declined join changes nothing", () =>
  Effect.gen(function* () {
    const hub = yield* setup();
    const first = yield* hub.membership.join(scope, { deviceAlias: "lidge-ts" });
    yield* hub.approve(first.decisionId!, "decline");
    const refused = yield* hub.membership
      .join(scope, { deviceAlias: "lidge-ts", decisionId: first.decisionId! })
      .pipe(Effect.flip);
    expect(refused.message).toContain("not approved");
    expect(hub.calls.some((call) => call.includes("link add"))).toBe(false);
  }),
);

it.effect("hub.manage without owner still needs an approved decision, even when pinned", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ profile: "hub-admin", pin: PINNED });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mac-studio" });
    expect(result.state).toBe("needs_human");
    expect(result.message).toContain("owner's approval");
  }),
);

it.effect("a profile without hub.manage is refused before any command runs", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ profile: "manager", pin: PINNED });
    const refused = yield* hub.membership
      .join(scope, { deviceAlias: "mac-studio" })
      .pipe(Effect.flip);
    expect(refused.code).toBe("capability_denied");
    expect(hub.calls).toEqual([]);
  }),
);

// What the WebSocket boundary passes for a session holding settings:write.
const person = { sessionId: owner.sessionId, scopes: owner.scopes };

it.effect("a person joins a pinned device directly, whatever the default profile allows", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ profile: "worker", pin: PINNED });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mac-studio" }, person);
    expect(result.state).toBe("child");
    expect(hub.calls).toContain(`home link add mac-studio --expect-fingerprint ${PINNED} --json`);
  }),
);

it.effect("a person's unpinned join files a decision that person answers, then joins", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ profile: "worker" });
    const first = yield* hub.membership.join(scope, { deviceAlias: "lidge-ts" }, person);
    expect(first.state).toBe("needs_human");
    expect(first.message).toContain("no pinned host key");
    const item = yield* hub.inbox.get(owner, first.decisionId!);
    expect(item.requiredProfile).toBe("owner");
    yield* hub.approve(first.decisionId!);
    const second = yield* hub.membership.join(
      scope,
      { deviceAlias: "lidge-ts", decisionId: first.decisionId! },
      person,
    );
    expect(second.state).toBe("child");
  }),
);

it.effect("a person leaves a device without a decision; the device is cleaned first", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ profile: "worker", linked: ["mac-studio"] });
    const result = yield* hub.membership.leave(scope, { deviceAlias: "mac-studio" }, person);
    expect(result.state).toBe("ready");
    expect(result.steps.map(({ step }) => step)).toEqual([
      "disconnect",
      "restart",
      "health",
      "revoke",
      "link_removed",
    ]);
  }),
);

it.effect("an alias behind ProxyJump is refused before probing", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ pin: PINNED, direct: false });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mac-studio" });
    expect(result.state).toBe("failed");
    expect(result.message).toContain("ProxyJump");
    expect(hub.calls).toEqual([]);
  }),
);

it.effect(
  "the repair ladder re-verifies after each rung and stops at the first clean verdict",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({
        linked: ["macmini-ts"],
        verdicts: [verdict(["P6"]), verdict(["P5"]), verdict()],
      });
      const result = yield* hub.membership.repair(scope, { deviceAlias: "macmini-ts" });
      expect(result.state).toBe("child");
      expect(hub.calls).toEqual([
        "home link status --json",
        "verify macmini-ts",
        "device macmini-ts sync",
        "verify macmini-ts",
        "device macmini-ts restart",
        "verify macmini-ts",
      ]);
      expect((yield* hub.audit).map(({ action, outcome }) => `${action} ${outcome}`)).toEqual([
        "hub.repair.sync ok",
        "hub.repair.restart ok",
        "hub.repair child",
      ]);
    }),
);

it.effect("restart defers while a turn runs and does not escalate to re-link", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ linked: ["macmini-ts"], running: 1, verdicts: [verdict(["P5"])] });
    const result = yield* hub.membership.repair(scope, { deviceAlias: "macmini-ts" });
    expect(result.state).toBe("degraded");
    expect(result.steps).toEqual([
      { step: "restart", outcome: "deferred", detail: expect.any(String) },
    ]);
    expect(result.decisionId).toBeUndefined();
    expect(hub.calls).not.toContain("device macmini-ts restart");
  }),
);

it.effect("an exhausted ladder asks to re-link; the approval re-links with the same key", () =>
  Effect.gen(function* () {
    const hub = yield* setup({
      linked: ["macmini-ts"],
      verdicts: [verdict(["P2"]), verdict(["P2"]), verdict()],
    });
    const asked = yield* hub.membership.repair(scope, { deviceAlias: "macmini-ts" });
    expect(asked.state).toBe("needs_human");
    expect(hub.calls).toContain("home link reconnect --link-id lnk_0123456789abcdef --json");
    yield* hub.approve(asked.decisionId!);
    const relinked = yield* hub.membership.repair(scope, {
      deviceAlias: "macmini-ts",
      decisionId: asked.decisionId!,
    });
    expect(relinked.state).toBe("child");
    expect(relinked.steps.map(({ step }) => step)).toEqual([
      "probe",
      "disconnect",
      "restart",
      "health",
      "revoke",
      "link_removed",
      "link_add",
    ]);
    expect(hub.calls).toContain(`home link add macmini-ts --expect-fingerprint ${PINNED} --json`);
  }),
);

it.effect("leave cleans the device first, then force-revokes and proves the link is gone", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ linked: ["lidge-ts"] });
    const result = yield* hub.membership.leave(scope, { deviceAlias: "lidge-ts" });
    expect(result.state).toBe("ready");
    expect(hub.calls).toEqual([
      "home link status --json",
      "device lidge-ts disconnect --json",
      "device lidge-ts restart",
      "health lidge-ts",
      "home link revoke --link-id lnk_0123456789abcdef --force --yes --json",
      "home link status --json",
      "tunnels lidge-ts 42255",
    ]);
  }),
);

it.effect(
  "a device disconnect that exits 125 files a decision and leaves the Home link alone",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({ linked: ["lidge-ts"], deviceExit: { disconnect: 125 } });
      const asked = yield* hub.membership.leave(scope, { deviceAlias: "lidge-ts" });
      expect(asked.state).toBe("needs_human");
      expect(asked.message).toContain("exited 125");
      expect(hub.calls.some((call) => call.includes("revoke"))).toBe(false);
      expect(hub.calls).not.toContain("device lidge-ts restart");
      const item = yield* hub.inbox.get(owner, asked.decisionId!);
      expect(item.requiredProfile).toBe("owner");

      yield* hub.approve(asked.decisionId!);
      const forced = yield* hub.membership.leave(scope, {
        deviceAlias: "lidge-ts",
        decisionId: asked.decisionId!,
      });
      expect(forced.state).toBe("degraded");
      expect(forced.message).toContain("ocx disconnect and ocx restart");
      expect(forced.steps.map(({ step }) => step)).toEqual(["revoke", "link_removed"]);
      expect((yield* hub.audit).map(({ outcome }) => outcome)).toEqual([
        "started",
        "needs_decision",
        "started",
        "degraded",
      ]);
    }),
);

it.effect("a device still reporting the client role after restart is not revoked", () =>
  Effect.gen(function* () {
    const hub = yield* setup({
      linked: ["lidge-ts"],
      health: { service: "opencodex", role: "client" },
    });
    const result = yield* hub.membership.leave(scope, { deviceAlias: "lidge-ts" });
    expect(result.state).toBe("needs_human");
    expect(result.message).toContain("role client");
    expect(hub.calls.some((call) => call.includes("revoke"))).toBe(false);
  }),
);

it.effect("a tunnel that outlives the revoke is reported", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ linked: ["lidge-ts"], strayTunnel: true });
    const result = yield* hub.membership.leave(scope, { deviceAlias: "lidge-ts" });
    expect(result.state).toBe("degraded");
    expect(result.steps.at(-1)).toMatchObject({ step: "link_removed", outcome: "failed" });
  }),
);
