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
import { fromFailure } from "@goat/contracts/agentSurface/envelope";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

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
  /**
   * Stops the server at the first progress record this matches: the record is stored when
   * `store` is set, then the call never returns, as if the process died there.
   */
  readonly crashAt?: { readonly when: (progress: Recorded) => boolean; readonly store: boolean };
  readonly remoteFailure?: Dispatch.SshRemoteDispatchError;
}

/** The encoded progress the fake handoff store holds. */
interface Recorded {
  readonly effects: Readonly<Record<string, string | undefined>>;
  readonly outcome?: { readonly state: string };
}

const setup = Effect.fn("ProviderSettingsTest.setup")(function* (fixture: Fixture = {}) {
  const now = yield* DateTime.now;
  const created: Array<Parameters<Handoffs.Handoffs["Service"]["create"]>[0]> = [];
  const prepared: string[] = [];
  const remote: Array<Parameters<Dispatch.SshRemoteDispatch["Service"]["callHostTool"]>[0]> = [];
  const finished: string[] = [];
  const progress = new Map<string, unknown>();
  const retained = new Map<string, unknown>();
  const crashed = yield* Deferred.make<void>();
  let crashUsed = false;
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
  const dependencies = yield* Layer.build(
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
                      ...(progress.has(`handoff:${index + 1}`)
                        ? { progress: progress.get(`handoff:${index + 1}`) }
                        : {}),
                    },
                  ]
                : [],
            ),
          ),
        recordProviderProgress: (input, next) =>
          Effect.gen(function* () {
            const crash =
              !crashUsed && fixture.crashAt !== undefined && fixture.crashAt.when(next as Recorded);
            if (!crash || fixture.crashAt?.store === true) progress.set(input.handoffId, next);
            if (!crash) return;
            crashUsed = true;
            yield* Deferred.succeed(crashed, undefined);
            return yield* Effect.never;
          }),
        finishProviderContinuation: (input, outcome) =>
          Effect.sync(() => {
            finished.push(input.handoffId);
            if (outcome !== undefined) retained.set(input.handoffId, outcome);
          }),
        readProviderProgress: (input) =>
          Effect.sync(() => retained.get(input.handoffId) ?? progress.get(input.handoffId)),
      }),
      Layer.mock(SessionStore.SessionStore)({
        cookieName: "goat_session",
        legacyCookieName: undefined,
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
          Effect.flatMap(authorize, () => {
            remote.push(call);
            if (fixture.remoteFailure !== undefined) return Effect.fail(fixture.remoteFailure);
            return Effect.succeed({
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
            });
          }),
      }),
      Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
        prepare: ({ agentId }) =>
          Effect.sync(() => {
            prepared.push(agentId);
            return { agentId, version: "3000.11.1", distribution: "binary", prepared: true };
          }),
      }),
    ).pipe(
      Layer.provideMerge(
        Settings.ServerSettingsService.layerTest({ providerInstances: fixture.instances ?? {} }),
      ),
      Layer.provideMerge(Sqlite.layerMemory),
    ),
  );
  /** A server start: a new ProviderSettings over the same settings, handoffs, and database. */
  const boot = Layer.build(Layer.fresh(ProviderSettings.layer)).pipe(
    Effect.provideContext(dependencies),
    Effect.map((context) => Context.get(context, ProviderSettings.ProviderSettings)),
  );
  const service = yield* boot;
  const settings = Context.get(dependencies, Settings.ServerSettingsService);
  const sql = Context.get(dependencies, SqlClient.SqlClient);
  return {
    service,
    boot,
    settings,
    crashed,
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
      // The approver is told the change failed, not that their request was invalid.
      expect(failed).toMatchObject({ reason: "invalid_request", outcome: "apply_failed" });
      expect(failed.message).toMatch(/^GOAT could not apply this change: /);
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
      expect(instances[ProviderInstanceId.make("devin")]).toMatchObject({
        driver: "acpRegistry",
        enabled: true,
        config: { source: "registry", agentId: "devin", distribution: "auto" },
      });
      expect(instances[ProviderInstanceId.make("devinCloud")]).toEqual({
        driver: "devinCloud",
        enabled: true,
        config: { siblingInstanceId: "devin" },
      });
      assert(result.kind === "applied");
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

it.effect("an add whose linkTo cannot be linked is refused before it installs or saves", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup();
      const before = Object.keys(yield* fixture.instances);
      // Devin from the registry cannot be Cursor Cloud's login source, and Claude is no cloud.
      const adds = [cursorCloud, ProviderInstanceId.make("claudeAgent")].map((linkTo) => ({
        action: "add" as const,
        input: { acpAgentId: "devin", linkTo },
      }));
      for (const add of adds) {
        const error = yield* Effect.flip(fixture.service.manage(add, managingClient));
        expect(error.code).toBe("invalid_request");
      }
      // A retry after the refusal would otherwise add devin-2 beside a leftover devin.
      expect(Object.keys(yield* fixture.instances)).toEqual(before);
      expect(fixture.prepared).toEqual([]);
      const approver = yield* setup({ capabilities: [] });
      for (const add of adds) {
        const error = yield* Effect.flip(approver.service.manage(add, threadScope));
        expect(error.code).toBe("invalid_request");
      }
      expect(approver.created).toEqual([]);
    }),
  ),
);

it.effect("tells a caller that a host too old for the provider tool needs updating", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup({
        remoteFailure: new Dispatch.SshRemoteDispatchError({
          reason: "remote_outdated",
          message: "GOAT on box does not have goat_provider_update; it runs 0.1.0.",
        }),
      });
      const failure = yield* Effect.flip(
        fixture.service.manage(
          { action: "update", input: { instanceId: cursorCloud, enabled: true, host: "box" } },
          managingClient,
        ),
      );
      expect(failure).toMatchObject({ code: "remote_outdated" });
      // goat_call classifies it as a precondition, not an internal error, and nothing ran.
      expect(fromFailure({ ...failure }, { effect: "write" })).toMatchObject({
        status: "error",
        error: { code: "failed_precondition", reason: "remote_outdated", retryable: false },
      });
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
      expect((yield* fixture.instances)[ProviderInstanceId.make("cursor")]?.enabled).toBe(true);
      // The asking thread is woken with this once the instance is on.
      const change = yield* fixture.service.readChange({
        threadId,
        handoffId: TurnItemId.make("handoff:1"),
      });
      expect(change?.outcome).toMatchObject({ state: "applied", result: { action: "update" } });
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

const devin = ProviderInstanceId.make("devin");
const devinCloud = ProviderInstanceId.make("devinCloud");
const handoff1 = { threadId, handoffId: TurnItemId.make("handoff:1") };
const addDevin = {
  action: "add" as const,
  input: { acpAgentId: "devin", linkTo: devinCloud },
};

/** Asks for an add, then approves it on a server that stops where the fixture says. */
const approveUntilCrash = Effect.fn("ProviderSettingsTest.approveUntilCrash")(function* (
  fixture: Effect.Success<ReturnType<typeof setup>>,
  request: Parameters<ProviderSettings.ProviderSettings["Service"]["manage"]>[0] = addDevin,
) {
  assert.strictEqual((yield* fixture.service.manage(request, threadScope)).kind, "needs_human");
  const approving = yield* fixture.service
    .respond({ ...handoff1, action: "completed" }, "person-session" as never)
    .pipe(Effect.forkChild);
  yield* Deferred.await(fixture.crashed);
  yield* Fiber.interrupt(approving);
});

it.effect("an add stopped between install and save resumes without installing again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* setup({
        capabilities: [],
        crashAt: { when: (p) => p.effects.install === "done", store: true },
      });
      yield* approveUntilCrash(fixture);
      expect(fixture.prepared).toEqual(["devin"]);
      expect((yield* fixture.instances)[devin]).toBeUndefined();

      // A change already under way finishes even after its approval clock ran out.
      yield* TestClock.adjust("1 hour");
      const restarted = yield* fixture.boot;
      yield* restarted.resumeContinuations;
      yield* restarted.resumeContinuations;

      expect(fixture.prepared).toEqual(["devin"]);
      const instances = yield* fixture.instances;
      expect(Object.keys(instances).toSorted()).toEqual(["devin", "devinCloud"]);
      expect(instances[devinCloud]?.config).toEqual({ siblingInstanceId: "devin" });
      const change = yield* restarted.readChange(handoff1);
      expect(change?.effects).toEqual({ install: "done", save: "done", link: "done" });
      assert(change?.outcome?.state === "applied");
      expect(change.outcome.result).toMatchObject({
        kind: "applied",
        installed: { agentId: "devin", version: "3000.11.1" },
        linked: { instanceId: "devinCloud" },
      });
      expect((yield* fixture.audit).map((row) => [row.actor, row.outcome])).toEqual([
        [`thread:${threadId}`, "needs_human"],
        ["client:person-session", "applied"],
      ]);
    }),
  ),
);

it.effect("a resumed add whose cloud target changed while stopped is refused before saving", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cloud = ProviderInstanceId.make("team-devin");
      const fixture = yield* setup({
        capabilities: [],
        instances: { [cloud]: { driver: ProviderDriverKind.make("devinCloud") } },
        crashAt: { when: (p) => p.effects.install === "done", store: true },
      });
      yield* approveUntilCrash(fixture, {
        action: "add",
        input: { acpAgentId: "devin", linkTo: cloud },
      });
      // The plan was checked when it was made; the target is no longer a Devin Cloud.
      yield* fixture.settings.updateProviderInstance({
        operation: "upsert",
        instanceId: cloud,
        instance: { driver: ProviderDriverKind.make("cursorCloud") },
      });

      const restarted = yield* fixture.boot;
      yield* restarted.resumeContinuations;
      expect(Object.keys(yield* fixture.instances)).toEqual([cloud]);
      expect((yield* restarted.readChange(handoff1))?.outcome).toMatchObject({
        state: "failed",
        reason: "invalid_request",
        message: expect.stringContaining("needs a Cursor instance"),
      });
    }),
  ),
);

it.effect(
  "an add stopped between save and link links the saved instance instead of a new one",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup({
          capabilities: [],
          crashAt: { when: (p) => p.effects.save === "done", store: true },
        });
        yield* approveUntilCrash(fixture);
        expect(Object.keys(yield* fixture.instances)).toEqual(["devin"]);

        const restarted = yield* fixture.boot;
        yield* restarted.resumeContinuations;
        const instances = yield* fixture.instances;
        expect(Object.keys(instances).toSorted()).toEqual(["devin", "devinCloud"]);
        expect(instances[devinCloud]?.config).toEqual({ siblingInstanceId: "devin" });
        expect(fixture.prepared).toEqual(["devin"]);
        expect((yield* restarted.readChange(handoff1))?.outcome?.state).toBe("applied");
      }),
    ),
);

it.effect("a save that may have landed is repeated only while the entry matches the plan", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // The process dies after the create committed and before its outcome was recorded.
      const landed = yield* setup({
        capabilities: [],
        crashAt: { when: (p) => p.effects.save === "done", store: false },
      });
      yield* approveUntilCrash(landed);
      yield* (yield* landed.boot).resumeContinuations;
      expect(Object.keys(yield* landed.instances).toSorted()).toEqual(["devin", "devinCloud"]);

      // Someone changed the entry before the restart: GOAT cannot tell whose it is.
      const changed = yield* setup({
        capabilities: [],
        crashAt: { when: (p) => p.effects.save === "done", store: false },
      });
      yield* approveUntilCrash(changed);
      yield* changed.settings.updateProviderInstance({
        operation: "upsert",
        instanceId: devin,
        instance: { driver: ProviderDriverKind.make("acpRegistry"), enabled: false },
      });
      const restarted = yield* changed.boot;
      yield* restarted.resumeContinuations;
      expect((yield* changed.instances)[devinCloud]).toBeUndefined();
      const change = yield* restarted.readChange(handoff1);
      expect(change?.outcome).toEqual({
        state: "unknown_outcome",
        effect: "save",
        reason: "instance_changed",
        message: expect.stringContaining("devin changed after GOAT began saving it"),
        reconcile: { call: "goat_provider_diagnose", arguments: { instanceId: "devin" } },
      });
      expect((yield* changed.audit).at(-1)?.outcome).toBe("unknown_outcome");
    }),
  ),
);

it.effect("an install or link left at started is repeated, since repeating them is safe", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const install = yield* setup({
        capabilities: [],
        crashAt: { when: (p) => p.effects.install === "started", store: true },
      });
      yield* approveUntilCrash(install);
      yield* (yield* install.boot).resumeContinuations;
      expect(install.prepared).toEqual(["devin"]);
      expect(Object.keys(yield* install.instances).toSorted()).toEqual(["devin", "devinCloud"]);

      const link = yield* setup({
        capabilities: [],
        crashAt: { when: (p) => p.effects.link === "started", store: true },
      });
      yield* approveUntilCrash(link);
      const restarted = yield* link.boot;
      yield* restarted.resumeContinuations;
      expect((yield* link.instances)[devinCloud]?.config).toEqual({ siblingInstanceId: "devin" });
      expect((yield* restarted.readChange(handoff1))?.outcome?.state).toBe("applied");
    }),
  ),
);

it.effect(
  "a settled outcome found after a restart is reported again without running anything",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup({
          capabilities: [],
          crashAt: { when: (p) => p.outcome !== undefined, store: true },
        });
        yield* approveUntilCrash(fixture);
        const before = yield* fixture.instances;
        const restarted = yield* fixture.boot;
        yield* restarted.resumeContinuations;
        expect(yield* fixture.instances).toEqual(before);
        expect(fixture.prepared).toEqual(["devin"]);
        expect((yield* restarted.readChange(handoff1))?.outcome?.state).toBe("applied");
        expect((yield* fixture.audit).map((row) => row.outcome)).toEqual(["needs_human"]);
      }),
    ),
);

it.effect("a host add that may have been sent is never sent again and names the read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const request = { action: "add" as const, input: { acpAgentId: "devin", host: "box" } };
      const stopped = yield* setup({
        capabilities: [],
        crashAt: { when: (p) => p.effects.remote === "started", store: true },
      });
      yield* approveUntilCrash(stopped, request);
      const restarted = yield* stopped.boot;
      yield* restarted.resumeContinuations;
      expect(stopped.remote).toEqual([]);
      expect((yield* restarted.readChange(handoff1))?.outcome).toMatchObject({
        state: "unknown_outcome",
        effect: "remote",
        reason: "effect_unconfirmed",
        reconcile: {
          call: "goat_provider_diagnose",
          arguments: { driver: "acpRegistry", host: "box" },
        },
      });

      // The connection dropped mid-call: the dispatch reason stays as the domain reason.
      const dropped = yield* setup({
        capabilities: [],
        remoteFailure: new Dispatch.SshRemoteDispatchError({
          reason: "ssh_failed",
          message: "Calling goat_provider_add on box failed: connection reset",
        }),
      });
      assert.strictEqual((yield* dropped.service.manage(request, threadScope)).kind, "needs_human");
      const refused = yield* Effect.flip(
        dropped.service.respond({ ...handoff1, action: "completed" }, "person-session" as never),
      );
      expect(refused).toBeInstanceOf(HandoffError);
      // It may have landed on box: the approver is told to check before approving again.
      expect(refused).toMatchObject({ reason: "invalid_request", outcome: "apply_unknown" });
      expect(refused.message).toContain("connection reset");
      expect(refused.message).toContain("Check the provider with Diagnose");
      yield* dropped.service.resumeContinuations;
      expect(dropped.remote).toHaveLength(1);
      expect((yield* dropped.service.readChange(handoff1))?.outcome).toMatchObject({
        state: "unknown_outcome",
        effect: "remote",
        reason: "ssh_failed",
      });
    }),
  ),
);
