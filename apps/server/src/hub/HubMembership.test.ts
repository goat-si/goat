import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  BUILTIN_PERMISSION_PROFILES,
  EnvironmentId,
  HandoffError,
  NodeId,
  ProviderInstanceId,
  RunId,
  MessageId,
  ThreadId,
  TurnItemId,
  handoffSummary,
  type Handoff,
  type OrchestrationV2ThreadProjection,
  type HubParityCheckId,
  type HubParityResult,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Inbox from "../goatclaw/DecisionInbox.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ApprovalHandoffs from "../handoffs/ApprovalHandoffs.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as PendingQuestions from "../mcp/PendingQuestionsMcpService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as HubMembership from "./HubMembership.ts";
import { type DevicePlatform, HubOcx, HubOcxError, type OcxOutput } from "./HubOcx.ts";
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
const asking = ThreadId.make("thread:hub-agent");
const threadScope: McpInvocationScope = {
  ...scope,
  client: undefined,
  thread: {
    threadId: asking,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
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
  readonly platform?: DevicePlatform;
  /** `ocx connect status --json` on the device. */
  readonly connection?: Readonly<Record<string, unknown>>;
  /** Home `ocx hub invite` exit; 0 mints a code. */
  readonly inviteExit?: number;
  readonly connectExit?: number;
  readonly addExit?: { readonly code: number; readonly phase: string };
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
      if (fixture.addExit) return Effect.succeed({ stdout: "", ...fixture.addExit });
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
    if (fixture.deviceDown?.includes(args[0]!))
      return Effect.fail(new HubOcxError({ reason: "unreachable", message: `${alias} is down.` }));
    if (args[0] === "connect" && args[1] === "status")
      return Effect.succeed(json(fixture.connection ?? { state: "disconnected" }));
    return Effect.succeed({
      code: fixture.deviceExit?.[args[0]!] ?? 0,
      stdout: "opencodex 2.83.0",
    });
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
  // Handoffs as the person's client sees them: created by the agent, answered in a GOAT app.
  const handoffs = new Map<string, { record: Handoff; args: string }>();
  const now = yield* DateTime.now;
  const handoffLayer = Layer.mock(Handoffs.Handoffs)({
    create: (input) =>
      Effect.sync(() => {
        const record: Handoff = {
          handoffId: TurnItemId.make(`handoff:${handoffs.size + 1}`),
          kind: input.kind,
          title: input.title,
          reason: input.reason,
          requestedBy: input.requestedBy,
          target: input.target,
          dedupeKey: "hmac",
          state: "pending",
          expiresAt: input.expiresAt ?? null,
          createdAt: now,
          actor: { type: "agent", threadId: input.requestedBy.threadId },
        };
        handoffs.set(record.handoffId, { record, args: JSON.stringify(input.args) });
        return handoffSummary(record);
      }),
    read: (input) => {
      const entry = handoffs.get(input.handoffId);
      return entry === undefined
        ? Effect.fail(new HandoffError({ reason: "not_found" }))
        : Effect.succeed(entry.record);
    },
    matchesArgs: (handoff, args) =>
      Effect.succeed(handoffs.get(handoff.handoffId)?.args === JSON.stringify(args)),
  });
  const run: OrchestrationV2ThreadProjection = {
    ...idleThreadProjection(liveThreadShell(asking)),
    runs: [
      {
        id: RunId.make("run:hub-agent"),
        threadId: asking,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fake" },
        providerThreadId: null,
        userMessageId: MessageId.make("message:hub-agent"),
        rootNodeId: NodeId.make("node:hub-agent"),
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
        memoryGrantCeiling: "none",
      },
    ],
  };
  const threadLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadRecords: () => Effect.succeed(run),
  });
  const context = yield* Layer.build(
    HubMembership.layerWithoutDependencies.pipe(
      Layer.provide(
        ApprovalHandoffs.layer.pipe(
          Layer.provide(handoffLayer),
          Layer.provide(threadLayer),
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("hub")),
            }),
          ),
        ),
      ),
      Layer.provide(
        Layer.succeed(
          HubOcx,
          HubOcx.of({
            home,
            device,
            devicePlatform: (alias) =>
              Effect.sync(() => {
                calls.push(`platform ${alias}`);
                return fixture.platform ?? "posix";
              }),
            connectHubClient: (alias) =>
              Effect.sync(() => {
                calls.push(`handoff ${alias}`);
                return (fixture.inviteExit ?? 0) !== 0
                  ? { minted: false as const, exit: fixture.inviteExit! }
                  : {
                      minted: true as const,
                      dataUrl: "https://hub.tailnet-example.ts.net:8443",
                      expiresAt: "2026-10-22T12:05:00.000Z",
                      connect: { code: fixture.connectExit ?? 0, stdout: "" },
                    };
              }),
            pinnedFingerprint: () => Effect.succeed(fixture.pin),
            prepareDevice: () => Effect.die("unused"),
            syncDevice: () => Effect.die("unused"),
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
                return (alias !== undefined && links.has(alias)) || fixture.strayTunnel ? 1 : 0;
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
      Layer.provide(threadLayer),
      Layer.provide(Layer.mock(PendingQuestions.PendingQuestionsMcpService)({})),
      Layer.provideMerge(Settings.layerTest({ goatclaw })),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provide(NodeCrypto.layer),
    ),
  );
  const membership = Context.get(context, HubMembership.HubMembership);
  const inbox = Context.get(context, Inbox.DecisionInbox);
  const sql = Context.get(context, SqlClient.SqlClient);
  // Profiles read the asking thread's own modes.
  yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${asking}, 'project', 'Hub agent', 'codex', 'full-access', 'default', '2026-10-23', '2026-10-23', '{}')`;
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
    /** A person answers a handoff in a GOAT client. */
    answer: (id: string, state: Handoff["state"] = "completed") =>
      Effect.sync(() => {
        const entry = handoffs.get(id)!;
        entry.record = {
          ...entry.record,
          state,
          actor: { type: "client", label: "Reviewer" },
          resolvedAt: now,
          resolvedBy: "Reviewer",
        };
      }),
    inboxItems: inbox.list(owner, {}),
    consumed: sql<{ readonly approval_id: string }>`SELECT approval_id FROM approval_consumptions`,
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
      "platform mac-studio",
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
    expect(hub.calls).toEqual(["home link status --json", "platform mac-studio"]);
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

const MINI_KEY = "0b7c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3";

it.effect("a Windows device joins as a Hub client: invite here, connect there, then parity", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ platform: "windows" });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mini" });
    expect(result).toMatchObject({ state: "child", transport: "hub-client" });
    expect(hub.calls).toEqual([
      "home link status --json",
      "platform mini",
      "device mini --version",
      "device mini connect status --json",
      "handoff mini",
      "verify mini",
    ]);
    expect(result.steps.map(({ step, outcome }) => `${step} ${outcome}`)).toEqual([
      "preflight ok",
      "invite ok",
      "connect ok",
    ]);
    // Nothing about Remote Link runs for a Hub client.
    expect(hub.calls.some((call) => call.includes("link probe") || call.includes("link add"))).toBe(
      false,
    );
    expect((yield* hub.audit).map(({ outcome }) => outcome)).toEqual(["started", "child"]);
  }),
);

it.effect("transport remote-link on Windows is refused before a probe or link add", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ platform: "windows", pin: PINNED });
    const result = yield* hub.membership.join(scope, {
      deviceAlias: "mini",
      transport: "remote-link",
    });
    expect(result).toMatchObject({ state: "failed", transport: "remote-link" });
    expect(result.message).toContain("remote_platform_unsupported");
    expect(result.steps).toEqual([
      { step: "preflight", outcome: "failed", detail: result.message },
    ]);
    expect(hub.calls).toEqual(["home link status --json", "platform mini"]);
    expect(yield* hub.audit).toEqual([]);
  }),
);

it.effect("an unreadable platform still meets OpenCodex's own refusal (exit 125)", () =>
  Effect.gen(function* () {
    const hub = yield* setup({
      pin: PINNED,
      addExit: { code: 125, phase: "remote_platform_unsupported" },
    });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mini" });
    expect(result.state).toBe("failed");
    expect(result.message).toBe(
      "Remote Link refuses this platform; it joins as a Hub-mode client instead.",
    );
  }),
);

it.effect("a password-only device can ask for a Hub client join on any platform", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ platform: "posix" });
    const result = yield* hub.membership.join(scope, {
      deviceAlias: "lidge",
      transport: "hub-client",
    });
    expect(result).toMatchObject({ state: "child", transport: "hub-client" });
    expect(hub.calls).toContain("handoff lidge");
  }),
);

it.effect("a hub that cannot mint an invite stops before touching the device", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ platform: "windows", inviteExit: 1 });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mini" });
    expect(result.state).toBe("failed");
    expect(result.message).toContain("Hub mode");
    expect(result.steps.at(-1)).toMatchObject({ step: "invite", outcome: "failed" });
    expect(hub.calls).not.toContain("verify mini");
    expect((yield* hub.audit).map(({ outcome }) => outcome)).toEqual(["started", "failed"]);
  }),
);

it.effect("a failed ocx connect is reported without parity", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ platform: "windows", connectExit: 1 });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mini" });
    expect(result.state).toBe("failed");
    expect(result.steps.at(-1)).toEqual({
      step: "connect",
      outcome: "failed",
      detail: "ocx connect exited 1; the unused code expires on its own.",
    });
    expect(hub.calls).not.toContain("verify mini");
  }),
);

// mini on 2026-10-22: a Home-initiated link that Git Bash let enroll, after the Home revoked it.
const miniLinkConnection = {
  state: "connected",
  serverUrl: "http://127.0.0.1:52889",
  transport: "link",
  link: { tunnelPort: 52889, linkId: "lnk_ac30f40bb6167a49" },
  apiKeyId: MINI_KEY,
};

it.effect("a device still holding a Remote Link connection is not given a second one", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ platform: "windows", connection: miniLinkConnection });
    const result = yield* hub.membership.join(scope, { deviceAlias: "mini" });
    expect(result.state).toBe("failed");
    expect(result.message).toContain("http://127.0.0.1:52889");
    expect(hub.calls).not.toContain("handoff mini");
  }),
);

it.effect("a non-owner Hub client join waits for an approval bound to that transport", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ profile: "hub-admin", pin: PINNED });
    const first = yield* hub.membership.join(scope, {
      deviceAlias: "lidge",
      transport: "hub-client",
    });
    expect(first).toMatchObject({ state: "needs_human", transport: "hub-client" });
    expect(hub.calls).not.toContain("handoff lidge");
    const item = yield* hub.inbox.get(owner, first.decisionId!);
    expect(item.context).toContain(HubMembership.decisionBinding("join", "lidge", "hub-client"));

    yield* hub.approve(first.decisionId!);
    // The same approval cannot be spent on a Remote Link join.
    const wrong = yield* hub.membership
      .join(scope, { deviceAlias: "lidge", decisionId: first.decisionId! })
      .pipe(Effect.flip);
    expect(wrong.code).toBe("invalid_request");

    const second = yield* hub.membership.join(scope, {
      deviceAlias: "lidge",
      transport: "hub-client",
      decisionId: first.decisionId!,
    });
    expect(second.state).toBe("child");
    expect(hub.calls.filter((call) => call === "handoff lidge")).toHaveLength(1);
  }),
);

it.effect("a Hub client leaves device first, then its data key is revoked on the hub", () =>
  Effect.gen(function* () {
    const hub = yield* setup({
      connection: {
        state: "connected",
        serverUrl: "https://hub.tailnet-example.ts.net:8443",
        apiKeyId: MINI_KEY,
      },
    });
    const result = yield* hub.membership.leave(scope, { deviceAlias: "mini" });
    expect(result).toMatchObject({ state: "ready", transport: "hub-client" });
    expect(hub.calls).toEqual([
      "home link status --json",
      "device mini connect status --json",
      "device mini disconnect --json",
      "device mini restart",
      "health mini",
      `home access key remove ${MINI_KEY} --yes --json`,
    ]);
  }),
);

it.effect("a device that is not joined leaves nothing to do", () =>
  Effect.gen(function* () {
    const hub = yield* setup();
    const result = yield* hub.membership.leave(scope, { deviceAlias: "mini" });
    expect(result.state).toBe("ready");
    expect(hub.calls.some((call) => call.includes("disconnect"))).toBe(false);
  }),
);

it.effect(
  "mini's legacy link: the device refuses ocx disconnect, so only a forced revoke remains",
  () =>
    Effect.gen(function* () {
      // "disconnect refused: Codex routing is injected but no journal records the original state"
      const hub = yield* setup({ linked: ["mini"], deviceExit: { disconnect: 1 } });
      const asked = yield* hub.membership.leave(scope, { deviceAlias: "mini" });
      expect(asked).toMatchObject({ state: "needs_human", transport: "remote-link" });
      expect(asked.message).toContain("ocx disconnect exited 1.");
      expect(hub.calls.some((call) => call.includes("revoke"))).toBe(false);

      yield* hub.approve(asked.decisionId!);
      const forced = yield* hub.membership.leave(scope, {
        deviceAlias: "mini",
        decisionId: asked.decisionId!,
      });
      expect(forced.state).toBe("degraded");
      expect(hub.calls).toContain(
        "home link revoke --link-id lnk_0123456789abcdef --force --yes --json",
      );
    }),
);

it.effect("a thread's unpinned join asks through a handoff whose id continues it once", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ addFails: true });
    const first = yield* hub.membership.join(threadScope, { deviceAlias: "lidge-ts" });
    expect(first).toMatchObject({
      kind: "needs_human",
      state: "needs_human",
      handoff: { kind: "approval", state: "pending", targetPath: "hub.device_join" },
      next: { after: "approval", call: "goat_hub_device_join" },
    });
    expect(first.decisionId).toBe((first as { handoff: { handoffId: string } }).handoff.handoffId);
    expect((yield* hub.inboxItems).items).toEqual([]);
    const early = yield* hub.membership
      .join(threadScope, { deviceAlias: "lidge-ts", decisionId: first.decisionId! })
      .pipe(Effect.flip);
    expect(early.message).toContain("still open");

    yield* hub.answer(first.decisionId!);
    const joined = yield* hub.membership.join(threadScope, {
      deviceAlias: "lidge-ts",
      decisionId: first.decisionId!,
    });
    expect(joined.state).toBe("failed");
    expect(hub.calls).toContain(`home link add lidge-ts --expect-fingerprint ${PINNED} --json`);
    const reused = yield* hub.membership
      .join(threadScope, { deviceAlias: "lidge-ts", decisionId: first.decisionId! })
      .pipe(Effect.flip);
    expect(reused.message).toContain("already used");
  }),
);

it.effect("a handoff covers only the change it was asked for", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ linked: ["box"] });
    const join = yield* hub.membership.join(threadScope, { deviceAlias: "lidge-ts" });
    yield* hub.answer(join.decisionId!);
    hub.offer(OTHER);
    const swapped = yield* hub.membership
      .join(threadScope, { deviceAlias: "lidge-ts", decisionId: join.decisionId! })
      .pipe(Effect.flip);
    expect(swapped.message).toContain("does not cover this change");
    const leave = yield* hub.membership
      .leave(threadScope, { deviceAlias: "box", decisionId: join.decisionId! })
      .pipe(Effect.flip);
    expect(leave.message).toContain("does not cover this change");
    const declined = yield* hub.membership.join(threadScope, { deviceAlias: "other-ts" });
    yield* hub.answer(declined.decisionId!, "declined");
    expect(
      (yield* hub.membership
        .join(threadScope, { deviceAlias: "other-ts", decisionId: declined.decisionId! })
        .pipe(Effect.flip)).message,
    ).toContain("was not given");
    expect(hub.calls.some((call) => call.includes("link add"))).toBe(false);
  }),
);

it.effect("a thread force-removes and re-links through handoffs bound to those steps", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ linked: ["lidge-ts"], deviceExit: { disconnect: 125 } });
    const asked = yield* hub.membership.leave(threadScope, { deviceAlias: "lidge-ts" });
    expect(asked).toMatchObject({
      kind: "needs_human",
      next: { call: "goat_hub_device_leave" },
      handoff: { targetPath: "hub.device_leave" },
    });
    yield* hub.answer(asked.decisionId!);
    const forced = yield* hub.membership.leave(threadScope, {
      deviceAlias: "lidge-ts",
      decisionId: asked.decisionId!,
    });
    expect(forced.state).toBe("degraded");
    expect(forced.steps.map(({ step }) => step)).toEqual(["revoke", "link_removed"]);

    const relinkHub = yield* setup({
      linked: ["macmini-ts"],
      verdicts: [verdict(["P2"]), verdict(["P2"]), verdict()],
    });
    const relink = yield* relinkHub.membership.repair(threadScope, { deviceAlias: "macmini-ts" });
    expect(relink).toMatchObject({ kind: "needs_human", next: { call: "goat_hub_device_repair" } });
    yield* relinkHub.answer(relink.decisionId!);
    const relinked = yield* relinkHub.membership.repair(threadScope, {
      deviceAlias: "macmini-ts",
      decisionId: relink.decisionId!,
    });
    expect(relinked.state).toBe("child");
  }),
);

it.effect(
  "an inbox approval answered by an owner-profile agent does not approve a hub change",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup();
      const asked = yield* hub.membership.join(scope, { deviceAlias: "lidge-ts" });
      expect(asked.state).toBe("needs_human");
      expect(asked).not.toHaveProperty("handoff");
      yield* hub.inbox.answer(
        { kind: "agent", scope },
        { id: asked.decisionId!, optionId: "approve", reason: "Looks fine." },
      );
      const refused = yield* hub.membership
        .join(scope, { deviceAlias: "lidge-ts", decisionId: asked.decisionId! })
        .pipe(Effect.flip);
      expect(refused.message).toContain("answered by an agent");
    }),
);

it.effect(
  "a decision an agent filed itself does not approve a hub change, even when a person answers it",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({ profile: "hub-admin" });
      const lookalike = yield* hub.inbox.create(
        { kind: "agent", scope },
        {
          title: "Join lidge-ts to the hub",
          context: `Looks routine.\n\n${HubMembership.decisionBinding("join", "lidge-ts", PINNED)}`,
          options: [
            { id: "approve", label: "Approve", consequence: "Joins." },
            { id: "decline", label: "Decline", consequence: "Nothing changes." },
          ],
          requiredProfile: "owner",
        },
      );
      yield* hub.approve(lookalike.id);
      const refused = yield* hub.membership
        .join(scope, { deviceAlias: "lidge-ts", decisionId: lookalike.id })
        .pipe(Effect.flip);
      expect(refused.message).toContain("not asked by GOAT");
      expect(hub.calls.some((call) => call.includes("link add"))).toBe(false);
      expect(yield* hub.consumed).toEqual([]);
    }),
);

it.effect("GOAT joins a cloud machine it pinned, under any default profile, without asking", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ pin: PINNED, profile: "observer" });
    const result = yield* hub.membership.joinProvisioned(scope, "boat-builder");
    expect(result.state).toBe("child");
    expect(hub.calls).toContain(`home link add boat-builder --expect-fingerprint ${PINNED} --json`);
    expect((yield* hub.inboxItems).items).toEqual([]);
    expect((yield* hub.audit).at(-1)).toMatchObject({ action: "hub.join", outcome: "child" });
  }),
);

it.effect("GOAT refuses a cloud machine whose offered key is not the one it pinned", () =>
  Effect.gen(function* () {
    for (const pin of [OTHER, undefined]) {
      const hub = yield* setup({ ...(pin === undefined ? {} : { pin }), offered: PINNED });
      const result = yield* hub.membership.joinProvisioned(scope, "boat-builder");
      expect(result.state).toBe("failed");
      expect(hub.calls.some((call) => call.startsWith("home link add"))).toBe(false);
      // No person is asked: a provisioning join never files a decision.
      expect((yield* hub.inboxItems).items).toEqual([]);
    }
  }),
);

it.effect("GOAT joining a cloud machine that is already linked changes nothing", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ pin: PINNED, linked: ["boat-builder"] });
    const result = yield* hub.membership.joinProvisioned(scope, "boat-builder");
    expect(result.state).toBe("child");
    expect(hub.calls).toEqual(["home link status --json", "verify boat-builder"]);
  }),
);

it.effect("GOAT never joins a host a person added without asking, even with a matching pin", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ pin: PINNED });
    const refused = yield* hub.membership.joinProvisioned(scope, "mac-studio").pipe(Effect.flip);
    expect(refused.code).toBe("invalid_request");
    expect(hub.calls).toEqual([]);
  }),
);
