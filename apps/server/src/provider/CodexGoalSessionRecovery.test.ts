import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexSurvivors from "./CodexSurvivors.ts";
import * as GoalRecovery from "./CodexGoalSessionRecovery.ts";
import * as SurvivorContinuation from "../orchestration-v2/Adapters/CodexSurvivorContinuation.ts";
import { refuseCodexAdmission } from "../orchestration-v2/goat/CodexTurnAdmission.ts";
import { CodexDetachedAppServerError } from "./CodexDetachedAppServer.ts";
import { makeLocalCommandHarness } from "../orchestration-v2/ProviderTurnStartService.localCommand.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";

it.effect("a goal-only instance reconnects and releases admission after the goal pauses", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex");
    const threadId = ThreadId.make("goal-thread");
    const key = { instanceId, recordName: "codex-abcdefabcdef" };
    const block = { threadId, nativeThreadId: "native-goal" };
    const blocked = yield* Ref.make(true);
    const cleared = yield* Deferred.make<void>();
    let attached = 0;
    let goalStatus = "active";
    let notify: ((payload: unknown) => Effect.Effect<void>) | undefined;
    const service = {
      list: Effect.succeed([]),
      listGoalBlocksByInstance: () =>
        Ref.get(blocked).pipe(Effect.map((active) => (active ? [{ record: key, block }] : []))),
      getGoalBlocks: () =>
        Ref.get(blocked).pipe(Effect.map((active) => (active ? [{ record: key, block }] : []))),
      getStopObligations: () => Effect.succeed([]),
      clearGoalBlock: () =>
        Ref.set(blocked, false).pipe(
          Effect.andThen(Deferred.succeed(cleared, undefined)),
          Effect.asVoid,
        ),
      ensureAdmission: (_thread: ThreadId, options?: { readonly allowGoalControl?: boolean }) =>
        Ref.get(blocked).pipe(
          Effect.flatMap((active) =>
            active && !options?.allowGoalControl
              ? Effect.fail(
                  new CodexDetachedAppServerError({
                    detail:
                      "Codex is still running a goal on this thread from before the restart. Send /goal pause or /goal clear to continue here.",
                  }),
                )
              : Effect.void,
          ),
        ),
      classifyRecord: () => Effect.succeed({ type: "verified" as const, pgid: 123, members: [] }),
    } as unknown as CodexSurvivors.CodexSurvivors["Service"];
    const client = {
      setRequestGuard: () => Effect.void,
      handleServerNotification: (
        _method: string,
        handler: (payload: unknown) => Effect.Effect<void>,
      ) =>
        Effect.sync(() => {
          notify = handler;
        }),
      request: (method: string) =>
        Effect.succeed(
          method === "thread/turns/list" ? { data: [] } : { goal: { status: goalStatus } },
        ),
      raw: { request: () => Effect.succeed({}) },
    } as unknown as CodexClient.CodexAppServerClient["Service"];
    const record = {
      name: key.recordName,
      instanceId,
      providerSessionId: ProviderSessionId.make("session"),
      state: "running",
      stderrMode: "discard",
      goalBlocks: [block],
    };
    const detached = { loadRecords: Effect.succeed([record]) };
    const projections = {
      getThreadRecords: () =>
        Effect.succeed({
          thread: {
            id: threadId,
            projectId: ProjectId.make("project"),
            modelSelection: { instanceId, model: "codex-model" },
            runtimeMode: "full-access",
            interactionMode: "default",
            worktreePath: "/workspace",
            deletedAt: null,
          },
          providerThreads: [
            {
              id: ProviderThreadId.make("provider-thread"),
              providerInstanceId: instanceId,
              providerSessionId: ProviderSessionId.make("session"),
              nativeThreadRef: { nativeId: block.nativeThreadId },
            },
          ],
          providerSessions: [],
        }),
    };
    const scope = yield* Scope.Scope;
    const sessions = {
      open: () =>
        Effect.gen(function* () {
          attached++;
          const notifications = yield* SurvivorContinuation.makeSurvivorNotifications({
            client,
            survivors: Option.some(service),
            instanceId,
            scope,
          });
          yield* notifications.handleNotification("thread/goal/updated", () => Effect.void);
          yield* notifications.resumeGoalThreads;
        }),
    };
    const admission = {
      survivors: Option.some(service),
      settings: yield* ServerSettings.ServerSettingsService.pipe(
        Effect.provide(ServerSettings.layerTest()),
      ),
      driver: ProviderDriverKind.make("codex"),
      threadId,
      projectId: ProjectId.make("project-goal-recovery"),
      settle: () => Effect.void,
    };
    assert.isTrue(yield* refuseCodexAdmission(admission));
    yield* GoalRecovery.attachGoalOnlySessions({
      detached,
      survivors: service,
      projections,
      sessions,
    } as never);
    assert.equal(attached, 1);
    const previousTurn = { runStatus: "completed", turnStatus: "completed" } as const;
    const run = (text: string) =>
      makeLocalCommandHarness({
        text,
        previousTurn,
        ensureCodexAdmission: service.ensureAdmission,
      });
    const refused = run("Continue");
    yield* refused.start;
    assert.equal(refused.startRootRun.mock.calls.length, 0);
    assert.include(
      JSON.stringify(refused.events),
      "Codex is still running a goal on this thread from before the restart. Send /goal pause or /goal clear to continue here.",
    );
    const pause = run("/goal pause");
    yield* pause.start;
    assert.equal(pause.startRootRun.mock.calls.length, 1);
    goalStatus = "paused";
    if (!notify) throw new Error("Goal notification handler was not registered");
    yield* notify({ threadId: block.nativeThreadId });
    yield* Deferred.await(cleared);
    assert.isFalse(yield* refuseCodexAdmission(admission));
    const next = run("Continue");
    yield* next.start;
    assert.equal(next.startRootRun.mock.calls.length, 1);
  }).pipe(Effect.scoped),
);

it.effect("an instance with a survivor binding does not open a second recovery session", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex");
    const recordName = "codex-abcdefabcdef";
    let opened = 0;
    const detached = {
      loadRecords: Effect.succeed([
        {
          instanceId,
          name: recordName,
          providerSessionId: "session",
          state: "running",
          stderrMode: "discard",
          goalBlocks: [{ threadId: ThreadId.make("goal"), nativeThreadId: "native" }],
        },
      ]),
    };
    const survivors = {
      list: Effect.succeed([{ instanceId, recordName }]),
      classifyRecord: () => Effect.die("unexpected classification"),
    };
    const sessions = {
      open: () =>
        Effect.sync(() => {
          opened++;
        }),
    };
    yield* GoalRecovery.attachGoalOnlySessions({
      detached,
      survivors,
      projections: {},
      sessions,
    } as never);
    assert.equal(opened, 0);
  }),
);

it.effect("each goal-only process reopens the session its record names", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex");
    const goal = (key: string) => ({
      instanceId,
      name: "codex-" + key.repeat(12),
      providerSessionId: "session-" + key,
      state: "running",
      stderrMode: "discard",
      goalBlocks: [{ threadId: ThreadId.make("goal-" + key), nativeThreadId: "native-" + key }],
    });
    const opened: string[] = [];
    yield* GoalRecovery.attachGoalOnlySessions({
      detached: { loadRecords: Effect.succeed([goal("a"), goal("b")]) },
      survivors: {
        list: Effect.succeed([]),
        classifyRecord: () => Effect.succeed({ type: "verified", pgid: 1, members: [] }),
      },
      projections: {
        getThreadRecords: (threadId: ThreadId) =>
          Effect.succeed({
            thread: {
              projectId: ProjectId.make("project"),
              modelSelection: { instanceId, model: "codex-model" },
              runtimeMode: "full-access",
              interactionMode: "default",
              worktreePath: "/workspace",
              deletedAt: null,
            },
            providerThreads: [
              {
                providerInstanceId: instanceId,
                providerSessionId: ProviderSessionId.make(threadId.replace("goal-", "session-")),
                nativeThreadRef: { nativeId: threadId.replace("goal-", "native-") },
              },
            ],
            providerSessions: [],
          }),
      },
      sessions: {
        open: (input: { readonly threadId: ThreadId; readonly providerSessionId: string }) =>
          Effect.sync(() => {
            opened.push(input.threadId + "@" + input.providerSessionId);
          }),
      },
    } as never);
    assert.deepEqual(opened, ["goal-a@session-a", "goal-b@session-b"]);
  }),
);
