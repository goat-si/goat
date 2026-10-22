import { assert, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type Handoff,
  HandoffError,
  handoffSummary,
  MessageId,
  NodeId,
  OrchestratorMcpFailure,
  PROVIDER_SETTINGS_HANDOFF_PATH,
  PROVIDER_SETUP_HANDOFF_PATH,
  type PermissionCapability,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as AcpRegistrySupport from "@goat/provider-acp-registry/server/AcpRegistrySupport";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SessionStore from "../auth/SessionStore.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ProviderSettings from "./ProviderSettings.ts";

const environmentId = EnvironmentId.make("env-provider-settings");
const threadId = ThreadId.make("thread-provider-settings");
const SECRET = "sk-provider-settings-secret";

const threadScope: McpInvocationScope = {
  environmentId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "provider-settings-test",
  thread: {
    threadId,
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  grantedScopes: ["orchestration:read"],
  reauthorize: () => Effect.void,
};
const managingClient: McpInvocationScope = {
  ...threadScope,
  thread: undefined,
  client: { sessionId: "client-session", label: "Client", access: "full-access" },
  grantedScopes: ["orchestration:operate", "providers:manage"],
};

interface Fixture {
  /** Capabilities the caller's goatclaw profile grants. */
  readonly capabilities?: ReadonlyArray<PermissionCapability>;
  readonly runtimeMode?: "full-access" | "auto";
  /** Scopes the approving person's session holds. */
  readonly approverScopes?: ReadonlyArray<string>;
  readonly instances?: Record<string, ProviderInstanceConfig>;
}

const setup = Effect.fn("ProviderSettingsTest.setup")(function* (fixture: Fixture = {}) {
  const now = yield* DateTime.now;
  const created: Array<Parameters<Handoffs.Handoffs["Service"]["create"]>[0]> = [];
  const prepared: string[] = [];
  const remote: Array<Parameters<Dispatch.SshRemoteDispatch["Service"]["callHostTool"]>[0]> = [];
  const finished: string[] = [];
  const handoffOf = (input: Parameters<Handoffs.Handoffs["Service"]["create"]>[0]): Handoff => ({
    handoffId: TurnItemId.make(`handoff:${created.length}`),
    kind: input.kind,
    title: input.title,
    reason: input.reason,
    requestedBy: input.requestedBy,
    target: input.target,
    dedupeKey: "k",
    state: "pending",
    expiresAt: input.expiresAt ?? null,
    createdAt: now,
    actor: { type: "agent", threadId },
  });
  const projection = {
    ...idleThreadProjection(liveThreadShell(threadId)),
    runs: [
      {
        id: RunId.make("run-1"),
        threadId,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
        providerThreadId: null,
        userMessageId: MessageId.make("message-1"),
        rootNodeId: NodeId.make("node-1"),
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
        memoryGrantCeiling: "none" as const,
      },
    ],
  };
  const capabilities = fixture.capabilities ?? ["providers.manage"];
  const context = yield* Layer.build(
    ProviderSettings.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Profiles.PermissionProfiles)({
            check: (_scope, capability) => {
              const profile = {
                id: "fixture",
                runtimeModeCeiling: "full-access" as const,
                capabilities,
                maxLanes: 1,
              };
              return Effect.succeed(
                capabilities.includes(capability)
                  ? {
                      ok: true as const,
                      effective: { enabled: true, profile, runtimeMode: "full-access" as const },
                    }
                  : { ok: false as const, reason: `Profile fixture does not allow ${capability}.` },
              );
            },
          }),
          Layer.mock(Threads.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(
                liveThreadShell(id, {
                  activeRunId: RunId.make("run-1"),
                  runtimeMode: fixture.runtimeMode ?? "full-access",
                }),
              ),
            getThreadSnapshot: () =>
              Effect.succeed({ schemaVersion: 1, snapshotSequence: 0, projection }),
          }),
          Layer.mock(Handoffs.Handoffs)({
            create: (input) =>
              Effect.sync(() => {
                created.push(input);
                return handoffSummary(handoffOf(input));
              }),
            respond: (input) =>
              Effect.sync(() => ({
                ...handoffOf(created[Number(input.handoffId.split(":")[1]) - 1]!),
                handoffId: input.handoffId,
                state: "completed" as const,
              })),
            completedProviderContinuations: (path) =>
              Effect.succeed(
                created.flatMap((input, index) =>
                  input.target.path === path && !finished.includes(`handoff:${index + 1}`)
                    ? [
                        {
                          handoff: {
                            ...handoffOf(input),
                            handoffId: TurnItemId.make(`handoff:${index + 1}`),
                            state: "completed" as const,
                          },
                          args: input.args,
                          approvedBySessionId: "person-session" as never,
                        },
                      ]
                    : [],
                ),
              ),
            finishProviderContinuation: (input) =>
              Effect.sync(() => {
                finished.push(input.handoffId);
              }),
          }),
          Layer.mock(SessionStore.SessionStore)({
            listActive: () =>
              Effect.succeed([
                {
                  sessionId: "person-session",
                  scopes: fixture.approverScopes ?? ["orchestration:operate", "providers:manage"],
                  client: { label: "Person" },
                } as never,
              ]),
          }),
          Layer.mock(Dispatch.SshRemoteDispatch)({
            callHostTool: (call, authorize) =>
              Effect.map(authorize, () => {
                remote.push(call);
                return {
                  kind: "applied",
                  action: "update",
                  instance: {
                    instanceId: "cursorCloud",
                    driver: "cursorCloud",
                    enabled: true,
                    environment: [],
                    configKeys: [],
                  },
                  next: { call: "goat_provider_diagnose" },
                };
              }),
          }),
          Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
            prepare: ({ agentId }) =>
              Effect.sync(() => {
                prepared.push(agentId);
                return { agentId, version: "3000.11.1", distribution: "binary", prepared: true };
              }),
          }),
        ),
      ),
      Layer.provideMerge(
        Settings.ServerSettingsService.layerTest({ providerInstances: fixture.instances ?? {} }),
      ),
      Layer.provideMerge(Sqlite.layerMemory),
    ),
  );
  const service = Context.get(context, ProviderSettings.ProviderSettings);
  const settings = Context.get(context, Settings.ServerSettingsService);
  const sql = Context.get(context, SqlClient.SqlClient);
  return {
    service,
    created,
    prepared,
    remote,
    instances: settings.getSettings.pipe(Effect.map((current) => current.providerInstances)),
    audit: sql<{ actor: string; action: string; target: string; outcome: string }>`
      SELECT actor, action, target, outcome FROM audit_events WHERE action LIKE 'provider.%' ORDER BY id`,
  };
});

const cursorCloud = ProviderInstanceId.make("cursorCloud");

it.effect("a full-access thread whose profile allows providers.manage enables Cursor Cloud", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup();
      const result = yield* fixture.service.manage(
        { action: "update", input: { instanceId: cursorCloud, enabled: true } },
        threadScope,
      );
      assert.strictEqual(result.kind, "applied");
      expect((yield* fixture.instances)[cursorCloud]).toEqual({
        driver: "cursorCloud",
        enabled: true,
      });
      expect(yield* fixture.audit).toEqual([
        {
          actor: `thread:${threadId}`,
          action: "provider.update",
          target: "cursorCloud@local",
          outcome: "applied",
        },
      ]);
    }),
  ),
);

it.effect("disables an instance and clears a legacy config flag when it is turned back on", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup({
        instances: {
          cursor: { driver: ProviderDriverKind.make("cursor"), config: { enabled: false } },
        },
      });
      const cursor = ProviderInstanceId.make("cursor");
      yield* fixture.service.manage(
        { action: "update", input: { instanceId: cursor, enabled: true } },
        managingClient,
      );
      expect((yield* fixture.instances)[cursor]).toEqual({
        driver: "cursor",
        enabled: true,
        config: {},
      });
      yield* fixture.service.manage(
        { action: "update", input: { instanceId: cursor, enabled: false } },
        managingClient,
      );
      expect((yield* fixture.instances)[cursor]?.enabled).toBe(false);
    }),
  ),
);

it.effect("a thread without providers.manage gets an approval that applies when approved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup({ capabilities: ["threads.launch"] });
      const result = yield* fixture.service.manage(
        { action: "update", input: { instanceId: cursorCloud, enabled: true } },
        threadScope,
      );
      assert.strictEqual(result.kind, "needs_human");
      expect(fixture.created[0]?.target.path).toBe(PROVIDER_SETTINGS_HANDOFF_PATH);
      expect(fixture.created[0]?.human.location).toContain(
        "Change provider cursorCloud: turn it on.",
      );
      expect((yield* fixture.instances)[cursorCloud]).toBeUndefined();

      const handoff = yield* fixture.service.respond(
        { threadId, handoffId: TurnItemId.make("handoff:1"), action: "completed" },
        "person-session" as never,
      );
      expect(handoff.state).toBe("completed");
      expect((yield* fixture.instances)[cursorCloud]?.enabled).toBe(true);
      expect((yield* fixture.audit).map((row) => [row.actor, row.outcome])).toEqual([
        [`thread:${threadId}`, "needs_human"],
        ["client:person-session", "applied"],
      ]);
    }),
  ),
);

it.effect("an approval by a person without providers:manage changes nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup({
        runtimeMode: "auto",
        approverScopes: ["orchestration:operate"],
      });
      const result = yield* fixture.service.manage(
        { action: "update", input: { instanceId: cursorCloud, enabled: true } },
        threadScope,
      );
      assert.strictEqual(result.kind, "needs_human");
      const failed = yield* Effect.flip(
        fixture.service.respond(
          { threadId, handoffId: TurnItemId.make("handoff:1"), action: "completed" },
          "person-session" as never,
        ),
      );
      expect(failed).toBeInstanceOf(HandoffError);
      expect((yield* fixture.instances)[cursorCloud]).toBeUndefined();
    }),
  ),
);

it.effect("refuses read-only clients and clients without providers:manage", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup();
      const request = {
        action: "update" as const,
        input: { instanceId: cursorCloud, enabled: true },
      };
      const readOnly = yield* Effect.flip(
        fixture.service.manage(request, {
          ...managingClient,
          client: { sessionId: "reader", label: "Reader", access: "read-only" },
        }),
      );
      const unscoped = yield* Effect.flip(
        fixture.service.manage(request, {
          ...managingClient,
          grantedScopes: ["orchestration:operate"],
        }),
      );
      for (const error of [readOnly, unscoped]) {
        expect(error).toBeInstanceOf(OrchestratorMcpFailure);
        expect(error.code).toBe("capability_denied");
      }
      expect(fixture.created).toEqual([]);
      expect((yield* fixture.instances)[cursorCloud]).toBeUndefined();
    }),
  ),
);

it.effect("adds Devin from the ACP Registry and links it to Devin Cloud", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup();
      const result = yield* fixture.service.manage(
        {
          action: "add",
          input: {
            acpAgentId: "devin",
            linkTo: ProviderInstanceId.make("devinCloud"),
            environment: [{ name: "DEVIN_TOKEN", value: SECRET, sensitive: true }],
          },
        },
        threadScope,
      );
      expect(fixture.prepared).toEqual(["devin"]);
      const instances = yield* fixture.instances;
      expect(instances.devin).toMatchObject({
        driver: "acpRegistry",
        enabled: true,
        config: { source: "registry", agentId: "devin", distribution: "auto" },
      });
      expect(instances.devinCloud).toEqual({
        driver: "devinCloud",
        enabled: true,
        config: { siblingInstanceId: "devin" },
      });
      assert.strictEqual(result.kind, "applied");
      expect(result.installed).toEqual({ agentId: "devin", version: "3000.11.1" });
      expect(result.instance?.environment).toEqual(["DEVIN_TOKEN"]);
      expect(result.linked?.instanceId).toBe("devinCloud");
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }),
  ),
);

it.effect("rejects linking a cloud provider to the wrong kind of instance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup({
        instances: { claude: { driver: ProviderDriverKind.make("claudeAgent") } },
      });
      const error = yield* Effect.flip(
        fixture.service.manage(
          {
            action: "link",
            input: {
              instanceId: cursorCloud,
              siblingInstanceId: ProviderInstanceId.make("claude"),
            },
          },
          managingClient,
        ),
      );
      expect(error.code).toBe("invalid_request");
      expect((yield* fixture.instances)[cursorCloud]).toBeUndefined();
    }),
  ),
);

it.effect("forwards a host change to that host's own tool with a providers:manage session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup();
      const result = yield* fixture.service.manage(
        { action: "update", input: { instanceId: cursorCloud, enabled: true, host: "box" } },
        managingClient,
      );
      expect(fixture.remote).toEqual([
        expect.objectContaining({
          host: "box",
          tool: "goat_provider_update",
          arguments: { instanceId: "cursorCloud", enabled: true },
          writes: true,
          providersManage: true,
        }),
      ]);
      expect(result).toMatchObject({ kind: "applied", host: "box" });
      expect((yield* fixture.instances)[cursorCloud]).toBeUndefined();
      expect((yield* fixture.audit)[0]?.target).toBe("cursorCloud@box");
    }),
  ),
);

it.effect("approving provider setup for an instance turns that instance on", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup({
        instances: { cursor: { driver: ProviderDriverKind.make("cursor"), enabled: false } },
      });
      const handoffs = fixture.created;
      handoffs.push({
        kind: "approval",
        title: "Set up Cursor?",
        reason: "An agent asked.",
        requestedBy: {
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          path: PROVIDER_SETUP_HANDOFF_PATH,
        },
        target: { environmentId, path: PROVIDER_SETUP_HANDOFF_PATH },
        runId: RunId.make("run-1"),
        nodeId: NodeId.make("node-1"),
        human: { location: "Set up Cursor." },
        args: { version: 1, driver: "cursor", instanceId: "cursor" },
      });
      yield* fixture.service.respond(
        { threadId, handoffId: TurnItemId.make("handoff:1"), action: "completed" },
        "person-session" as never,
      );
      expect((yield* fixture.instances).cursor?.enabled).toBe(true);
    }),
  ),
);

it.effect("hands diagnosis fixes with a call to permitted callers only", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const diagnosis = {
        checkedBy: "server" as const,
        host: "box",
        diagnoses: [
          {
            instanceId: cursorCloud,
            driver: ProviderDriverKind.make("cursorCloud"),
            configured: false,
            ready: false,
            checks: [
              {
                id: "enabled",
                status: "fail" as const,
                summary: "Cursor Cloud is disabled.",
                fix: {
                  actor: "human" as const,
                  instruction: "Enable Cursor Cloud in Settings → Providers.",
                  path: "provider.setup",
                  handoff: "approval" as const,
                  call: {
                    tool: "goat_provider_update",
                    arguments: { instanceId: "cursorCloud", enabled: true },
                  },
                },
              },
            ],
          },
        ],
      };
      const permitted = yield* (yield* setup()).service.presentDiagnosis(diagnosis, threadScope);
      expect(permitted.diagnoses[0]?.checks[0]?.fix).toMatchObject({
        actor: "agent",
        path: "provider.update",
        call: {
          tool: "goat_provider_update",
          arguments: { instanceId: "cursorCloud", enabled: true, host: "box" },
        },
      });
      const other = yield* (yield* setup({ capabilities: [] })).service.presentDiagnosis(
        diagnosis,
        threadScope,
      );
      expect(other).toEqual(diagnosis);
    }),
  ),
);
