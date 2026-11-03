import { assert, describe, it } from "@effect/vitest";
import type { ChannelConversationId, ChannelTask } from "@goat/contracts";
import { BUILTIN_PERMISSION_PROFILES, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ChannelSessionReceiptGate from "../mcp/ChannelSessionReceiptGate.ts";
import { requireDeclaredCapability } from "../mcp/McpToolAccess.ts";
import * as ServerSettings from "../serverSettings.ts";

import * as ChannelBotSession from "./ChannelBotSession.ts";
import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { goatBotSessionThreadIdFor, taskIdFor } from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import * as SqlClient from "effect/sql/SqlClient";
import {
  environmentId,
  owner,
  projectId,
  rpcContext,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";
import {
  ask,
  botModel,
  current,
  runsOf,
  sessionHarness,
  settle,
} from "./ChannelBotSession.testkit.ts";

/** Links Slack user U2 as a teammate, who sees the owner's other work only with orchestration:read. */
const linkTeammate = Effect.gen(function* () {
  const identities = yield* ChannelIdentityService.ChannelIdentityService;
  const gateway = yield* ChannelGateway.ChannelGateway;
  const { code } = yield* identities.createLink(
    {
      connectionId: "slack-1",
      runtimeModeCeiling: "auto-accept-edits",
      grantedScopes: ["orchestration:read", "orchestration:operate"],
    },
    { ...owner, principalId: "teammate", displayName: "Teammate" },
  );
  yield* gateway.linkIdentity(
    {
      connectionId: "slack-1",
      externalActorId: "U2",
      code,
      idempotencyKey: "link-U2",
      replyAddress: slackInput("", "unused").replyAddress,
    },
    slackContext,
  );
});

const narrowTeammate = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`UPDATE channel_identities SET granted_scopes_json = '["orchestration:operate"]' WHERE connection_id = 'slack-1' AND external_actor_id = 'U2'`,
);

/** The teammate's message in one Slack thread, read but not yet dispatched. */
const receiveFromTeammate = (text: string, key: string) =>
  Effect.gen(function* () {
    const gateway = yield* ChannelGateway.ChannelGateway;
    const reception = yield* ChannelReceptionService.ChannelReceptionService;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    yield* runtime.drain;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const ingested = yield* gateway.ingest(
      slackInput(text, key, "1760000000.000900", "U2"),
      slackContext,
    );
    yield* reception.receive(ingested.inputId, runtime.ownerToken);
    return (yield* ledger.getTask(taskIdFor(ingested.inputId, 0)))!.task;
  });

const dispatchNow = (task: ChannelTask) =>
  Effect.gen(function* () {
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
    yield* dispatcher.dispatch(task.taskId, runtime.ownerToken);
    return yield* current(task.taskId);
  });

/** The teammate's message, claimed for a session turn whose launch has not run yet. */
const claimedFromTeammate = (key: string, memoryGrantCeiling?: "read" | "read_write") =>
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const task = yield* receiveFromTeammate("look: claimed look", key);
    yield* commitTransition(
      ledger,
      (yield* ledger.getTask(task.taskId))!,
      {
        type: "task.dispatch.claimed",
        payload: {
          generation: task.generation,
          target: {
            environmentId,
            projectId,
            modelSelection: botModel,
            runtimeMode: "auto-accept-edits",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            ...(memoryGrantCeiling === undefined ? {} : { memoryGrantCeiling }),
          },
          leaseExpiresAt: "2026-10-12T00:00:00.000Z",
        },
      },
      { owner: runtime.ownerToken },
    );
    return (yield* ledger.getTask(task.taskId))!;
  });

describe("GOAT Bot sessions under the requester's current authority", () => {
  it.effect.each([
    { runtimeMode: "auto", profile: "owner" },
    { runtimeMode: "auto-accept-edits", profile: "owner" },
    { runtimeMode: "auto", profile: "worker" },
    { runtimeMode: "auto-accept-edits", profile: "worker" },
  ] as const)(
    "#2194: a $runtimeMode supervisor using $profile refuses direct PR writes within the requester's ceiling",
    ({ runtimeMode, profile }) => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ goatclaw: { enabled: true, defaultProfile: profile } });
        yield* setupBot;
        const task = yield* ask("look: check merge", `low-supervisor-${runtimeMode}`, {
          ...rpcContext,
          runtimeModeCeiling: runtimeMode,
        });
        const thread = task.worker!.threadId;
        const sql = yield* SqlClient.SqlClient;
        const [binding] = yield* sql<{ ceiling: string; profile: string }>`
          SELECT json_extract(ceiling_json, '$.runtimeModeCeiling') AS ceiling, profile_id AS profile
          FROM goatclaw_thread_profiles WHERE thread_id = ${thread}`;
        assert.deepStrictEqual(binding, { ceiling: runtimeMode, profile });
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
          VALUES (${thread}, 'project', 'Session', 'codex', ${runtimeMode}, 'default', '2026-10-25', '2026-10-25', '{}')`;
        const profiles = yield* Profiles.PermissionProfiles;
        const scope: McpInvocationContext.McpInvocationScope = {
          environmentId,
          requestNamespace: `provider:${thread}`,
          thread: {
            threadId: thread,
            providerSessionId: "session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 0,
        };
        const effective = yield* profiles.resolve(scope);
        assert.strictEqual(effective.runtimeMode, runtimeMode);
        assert.strictEqual(effective.profile.runtimeModeCeiling, runtimeMode);
        assert.strictEqual(effective.narrowing?.role, "supervisor");
        assert.deepStrictEqual(
          effective.profile.capabilities,
          BUILTIN_PERMISSION_PROFILES[profile]!.capabilities,
        );
        const outcomes: string[] = [];
        for (const path of ["pull_request.merge", "pull_request.close"]) {
          outcomes.push(
            yield* requireDeclaredCapability(profiles, path, "write", {}).pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
              Effect.provideService(ChannelSessionReceiptGate.ChannelSessionReceiptGate, {
                require: () => Effect.void,
              }),
              Effect.match({ onFailure: (error) => error.code, onSuccess: () => "admitted" }),
            ),
          );
        }
        assert.deepStrictEqual(outcomes, ["capability_denied", "capability_denied"]);
      }).pipe(Effect.provide(Profiles.layer.pipe(Layer.provideMerge(harness.layer))));
    },
  );
  it.effect("#2194: a session outside supervisor mode is not role-bound", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const task = yield* ask("look: non-supervisor", "ordinary-session");
      const sql = yield* SqlClient.SqlClient;
      const rows =
        yield* sql`SELECT profile_id FROM goatclaw_thread_profiles WHERE thread_id = ${task.worker!.threadId}`;
      assert.deepStrictEqual(rows, []);
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("#2194: a supervisor session does not launch if its role binding fails", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ goatclaw: { enabled: true, defaultProfile: "owner" } });
      yield* setupBot;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER refuse_bot_binding BEFORE INSERT ON goatclaw_thread_profiles
        BEGIN SELECT RAISE(ABORT, 'binding unavailable'); END`;
      yield* ask("look: check the merge", "refused-supervisor-binding");
      assert.lengthOf(harness.world.launches, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("#2194: a GOAT Bot supervisor delegates merges but cannot write PRs itself", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ goatclaw: { enabled: true, defaultProfile: "worker" } });
      yield* setupBot;
      const task = yield* ask("look: check the merge", "supervisor-permissions");
      const thread = task.worker!.threadId;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES (${thread}, 'project', 'Session', 'codex', 'full-access', 'default', '2026-10-25', '2026-10-25', '{}')`;
      const profiles = yield* Profiles.PermissionProfiles;
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: `provider:${thread}`,
        thread: {
          threadId: thread,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 0,
      };
      const merger = yield* profiles.claim(scope, {
        id: "merger",
        runtimeMode: "auto",
        role: "merge-manager",
      });
      assert.include(merger.profile.capabilities, "pr.merge");
      const outcomes: string[] = [];
      for (const path of ["pull_request.merge", "pull_request.close"]) {
        const result = yield* requireDeclaredCapability(profiles, path, "write", {}).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(ChannelSessionReceiptGate.ChannelSessionReceiptGate, {
            require: () => Effect.void,
          }),
          Effect.match({ onFailure: (error) => error.code, onSuccess: () => "admitted" }),
        );
        outcomes.push(result);
      }
      assert.deepStrictEqual(outcomes, ["capability_denied", "capability_denied"]);
    }).pipe(Effect.provide(Profiles.layer.pipe(Layer.provideMerge(harness.layer))));
  });
  it.effect(
    "builds a session's journal from the requester's current scopes, not the ones at intake",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* ask("look: payroll export", "j0");
        yield* linkTeammate;
        const task = yield* receiveFromTeammate("look: check the build", "j1");
        assert.include(task.requester.grantedScopes, "orchestration:read");
        yield* narrowTeammate;
        const served = yield* dispatchNow(task);
        const launch = harness.world.launches.find(
          (candidate) => candidate.threadId === served.worker?.threadId,
        );
        assert.include(launch!.initialMessage!.text, "check the build");
        assert.notInclude(launch!.initialMessage!.text, "payroll export");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("does not reuse a session whose prefix was built under wider scopes", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* ask("look: payroll export", "w0");
      yield* linkTeammate;
      const wide = yield* dispatchNow(yield* receiveFromTeammate("look: first look", "w1"));
      const wideThread = wide.worker!.threadId;
      const wideLaunch = harness.world.launches.find((launch) => launch.threadId === wideThread);
      assert.include(wideLaunch!.initialMessage!.text, "payroll export");
      harness.world.setStatus(wideThread, 1, "completed", "Done.");
      yield* settle;
      yield* narrowTeammate;
      const narrow = yield* dispatchNow(yield* receiveFromTeammate("look: second look", "w2"));
      assert.notStrictEqual(narrow.worker?.threadId, wideThread);
      assert.isFalse(
        harness.world.sends.some(
          (send) => send.threadId === wideThread && JSON.stringify(send).includes("second look"),
        ),
      );
      const narrowLaunch = harness.world.launches.find(
        (launch) => launch.threadId === narrow.worker?.threadId,
      );
      assert.notInclude(narrowLaunch!.initialMessage!.text, "payroll export");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "refuses to start a session for a requester whose link was removed after the task was claimed",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkTeammate;
        const stored = yield* claimedFromTeammate("u1");
        const identities = yield* ChannelIdentityService.ChannelIdentityService;
        yield* identities.unlink({ connectionId: "slack-1", externalActorId: "U2" });
        const session = yield* ChannelBotSession.ChannelBotSession;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        assert.strictEqual(yield* session.serve(stored, runtime.ownerToken), "failed");
        const after = yield* current(stored.task.taskId);
        assert.strictEqual(after.status, "failed");
        assert.lengthOf(harness.world.launches, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "starts a session with no more memory than the requester's current scopes allow",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkTeammate;
        // The claim recorded memory reads; the teammate's link grants none now.
        const stored = yield* claimedFromTeammate("m1", "read");
        const session = yield* ChannelBotSession.ChannelBotSession;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        assert.strictEqual(yield* session.serve(stored, runtime.ownerToken), "served");
        assert.lengthOf(harness.world.launches, 1);
        assert.isUndefined(harness.world.launches[0]!.initialMessage?.memoryGrantCeiling);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  /** A launch that committed its run but whose pass ended before binding it, as a crash leaves it. */
  const interruptedLaunch = (harness: ReturnType<typeof sessionHarness>, key: string) =>
    Effect.gen(function* () {
      const task = yield* receiveFromTeammate("look: first look", key);
      const thread = goatBotSessionThreadIdFor(task.conversationId as ChannelConversationId, 1);
      harness.world.failLaunchAfterAccept = true;
      harness.world.recordFailures.add(thread);
      const pending = yield* dispatchNow(task);
      harness.world.failLaunchAfterAccept = false;
      assert.isUndefined(pending.worker);
      assert.lengthOf(runsOf(harness, thread), 1);
      return { task, thread };
    });

  const sessionState = (thread: ThreadId) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql<{
          readonly state: string;
        }>`SELECT state FROM channel_bot_sessions WHERE thread_id = ${thread}`,
    ).pipe(Effect.map((rows) => rows[0]?.state));

  it.effect(
    "binds an interrupted launch's run after a narrowing, waiting while its session cannot be read",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkTeammate;
        const { task, thread } = yield* interruptedLaunch(harness, "b1");
        yield* narrowTeammate;
        const waiting = yield* dispatchNow(task);
        assert.isUndefined(waiting.worker);
        assert.lengthOf(harness.world.launches, 1);
        harness.world.recordFailures.delete(thread);
        const bound = yield* dispatchNow(task);
        assert.strictEqual(bound.worker?.threadId, thread);
        assert.strictEqual(bound.worker?.runId, runsOf(harness, thread)[0]!.id);
        assert.lengthOf(harness.world.launches, 1);
        assert.lengthOf(harness.world.sends, 0);
        assert.strictEqual(yield* sessionState(thread), "active");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("binds an interrupted launch's run after the requester's link is removed", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkTeammate;
      const { task, thread } = yield* interruptedLaunch(harness, "b2");
      const identities = yield* ChannelIdentityService.ChannelIdentityService;
      yield* identities.unlink({ connectionId: "slack-1", externalActorId: "U2" });
      harness.world.recordFailures.delete(thread);
      const bound = yield* dispatchNow(task);
      assert.strictEqual(bound.status, "running");
      assert.strictEqual(bound.worker?.threadId, thread);
      assert.lengthOf(harness.world.launches, 1);
    }).pipe(Effect.provide(harness.layer));
  });
});
