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

/** The hub's OpenCodex, parity and inbox as doubles around a real HubMembership. */
export const PINNED = "SHA256:pinnedpinnedpinnedpinnedpinnedpinnedpinned0";
export const OTHER = "SHA256:otherotherotherotherotherotherotherotherot0";
export const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("hub"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "hub-test",
  thread: undefined,
  client: { sessionId: "agent", label: "Agent", access: "full-access" },
};
export const asking = ThreadId.make("thread:hub-agent");
export const threadScope: McpInvocationScope = {
  ...scope,
  client: undefined,
  thread: {
    threadId: asking,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};
export const owner = {
  kind: "client",
  sessionId: "person",
  environmentId: EnvironmentId.make("hub"),
  scopes: ["orchestration:operate", "settings:write"],
} satisfies Inbox.DecisionCaller;
export const verdict = (failing: ReadonlyArray<HubParityCheckId> = []): HubParityResult => ({
  verdict: failing.length === 0 ? "ok" : failing.some((id) => id <= "P4") ? "broken" : "degraded",
  checkedAt: 0,
  failingCheckIds: failing,
  checks: failing.map((id) => ({ id, status: "failed", reason: "fixture" })),
});

export interface Fixture {
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

export const setup = Effect.fn("HubMembershipTest.setup")(function* (fixture: Fixture = {}) {
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
        // @effect-diagnostics-next-line preferSchemaOverJson:off -- compares handoff args as the store does.
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
                // @effect-diagnostics-next-line preferSchemaOverJson:off -- the device's raw /healthz body.
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
    provisioned: sql<{
      readonly alias: string;
      readonly link_id: string | null;
      readonly adding_since: string | null;
    }>`SELECT alias, link_id, adding_since FROM hub_provisioned_links ORDER BY alias`,
    offer: (fingerprint: string) => {
      offered = fingerprint;
    },
  };
});
