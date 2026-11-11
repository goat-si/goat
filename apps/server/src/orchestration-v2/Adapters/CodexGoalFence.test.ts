import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSurvivors from "../../provider/CodexSurvivors.ts";
import { CodexDetachedAppServerError } from "../../provider/CodexDetachedAppServer.ts";
import { makeSurvivorNotifications } from "./CodexSurvivorContinuation.ts";
import { makeGoalTurnFences } from "./CodexGoalTurnFences.ts";
import { refuseCodexAdmission } from "../goat/CodexTurnAdmission.ts";
import * as ServerSettings from "../../serverSettings.ts";

const scenario = (snapshot: boolean, race = false) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("goal-thread");
    const record = { instanceId: ProviderInstanceId.make("codex"), recordName: "record" };
    const block = { threadId, nativeThreadId: "native-thread" };
    let goalBlocked = true;
    let stopped = false;
    let goalStatus: "active" | "paused" = "active";
    const requests: string[] = [];
    const cleared = yield* Deferred.make<void>();
    const writeStarted = yield* Deferred.make<void>();
    const writeReleased = yield* Deferred.make<void>();
    const terminalRead = yield* Deferred.make<void>();
    const pauseRequested = yield* Deferred.make<unknown>();
    const service = {
      list: Effect.succeed([]),
      listGoalBlocksByInstance: () => Effect.succeed([{ record, block }]),
      getGoalBlocks: () => Effect.sync(() => (goalBlocked ? [{ record, block }] : [])),
      getStopObligations: () =>
        Effect.sync(() => (stopped ? [{ record, block: { ...block, nativeTurnId: "U" } }] : [])),
      recordStopObligation: (key: typeof record, stop: typeof block & { nativeTurnId: string }) =>
        Effect.gen(function* () {
          assert.deepEqual(key, record);
          assert.deepEqual(stop, { ...block, nativeTurnId: "U" });
          if (race) {
            yield* Deferred.succeed(writeStarted, undefined);
            yield* Deferred.await(writeReleased);
          }
          stopped = true;
        }),
      clearStopObligation: () =>
        Effect.sync(() => {
          stopped = false;
        }),
      clearGoalBlock: () =>
        Effect.sync(() => {
          goalBlocked = false;
        }).pipe(Effect.andThen(Deferred.succeed(cleared, undefined)), Effect.asVoid),
      hasGoalBlock: () => Effect.sync(() => goalBlocked),
      ensureAdmission: () =>
        stopped
          ? Effect.fail(
              new CodexDetachedAppServerError({
                detail: "Codex is running work on this thread from before the restart.",
              }),
            )
          : goalBlocked
            ? Effect.fail(new CodexDetachedAppServerError({ detail: "goal blocked" }))
            : Effect.void,
    } as unknown as CodexSurvivors.CodexSurvivors["Service"];
    const handlers = new Map<string, (payload: unknown) => Effect.Effect<void>>();
    const client = {
      setRequestGuard: () => Effect.void,
      handleServerNotification: (
        method: string,
        handler: (payload: unknown) => Effect.Effect<void>,
      ) =>
        Effect.sync(() => {
          handlers.set(method, handler);
        }),
      request: (method: string, params: unknown) =>
        Effect.gen(function* () {
          requests.push(method);
          if (method === "thread/goal/get") yield* Deferred.succeed(terminalRead, undefined);
          if (method === "thread/goal/set") yield* Deferred.succeed(pauseRequested, params);
          return method === "thread/turns/list"
            ? { data: snapshot ? [{ id: "U", status: "inProgress" }] : [] }
            : { goal: { status: goalStatus } };
        }),
      raw: { request: () => Effect.succeed({}) },
    } as unknown as CodexClient.CodexAppServerClient["Service"];
    const hooks = yield* makeSurvivorNotifications({
      client,
      survivors: Option.some(service),
      instanceId: record.instanceId,
      scope: yield* Scope.Scope,
    });
    for (const method of ["turn/started", "turn/completed", "thread/goal/updated"] as const)
      yield* hooks.handleNotification(method, () => Effect.void);
    if (race) {
      const resume = yield* Effect.forkScoped(hooks.resumeGoalThreads);
      yield* Deferred.await(writeStarted);
      yield* handlers.get("turn/completed")!({
        threadId: block.nativeThreadId,
        turn: { id: "U", status: "completed" },
      });
      yield* Deferred.succeed(writeReleased, undefined);
      yield* Fiber.join(resume);
      assert.isFalse(stopped, "completion racing the fence write must clear the obligation");
      goalStatus = "paused";
      yield* handlers.get("thread/goal/updated")!({ threadId: block.nativeThreadId });
      yield* Deferred.await(cleared);
      return;
    }
    yield* hooks.resumeGoalThreads;
    yield* handlers.get("turn/completed")!({
      threadId: block.nativeThreadId,
      turn: { id: "T", status: "completed" },
    });
    yield* Deferred.await(terminalRead);
    if (!snapshot)
      yield* handlers.get("turn/started")!({
        threadId: block.nativeThreadId,
        turn: { id: "U", status: "inProgress" },
      });
    assert.isTrue(stopped, "the running native turn must be fenced");
    assert.deepEqual(
      yield* Deferred.await(pauseRequested),
      { threadId: block.nativeThreadId, status: "paused" },
      "Codex must not continue the goal after the fenced turn",
    );
    goalStatus = "paused";
    yield* handlers.get("thread/goal/updated")!({
      threadId: block.nativeThreadId,
      goal: { status: "paused" },
    });
    assert.isTrue(stopped);
    assert.isTrue(goalBlocked);
    assert.equal(
      (yield* Effect.flip(service.ensureAdmission(threadId))).detail,
      "Codex is running work on this thread from before the restart.",
    );
    yield* handlers.get("turn/completed")!({
      threadId: block.nativeThreadId,
      turn: { id: "U", status: "completed" },
    });
    yield* Deferred.await(cleared);
    assert.isFalse(stopped);
    assert.isFalse(goalBlocked);
    yield* service.ensureAdmission(threadId);
    assert.notInclude(requests, "turn/interrupt");
  }).pipe(Effect.scoped);

it.effect("a newer goal turn keeps admission blocked after pause until native completion", () =>
  scenario(false),
);
it.effect("a goal turn already running at resume is fenced until native completion", () =>
  scenario(true),
);
it.effect("a native completion racing the resume fence does not leave a stale obligation", () =>
  scenario(true, true),
);

it.effect("a goal turn fence clears only after the retained process is verified gone", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("goal-thread");
    const record = { instanceId: ProviderInstanceId.make("codex"), recordName: "record" };
    const block = { threadId, nativeThreadId: "native-thread" };
    let gone = false;
    let leftovers = true;
    let stopped = true;
    const service = {
      classifyRecord: () =>
        Effect.sync(() =>
          gone
            ? { type: "gone" as const, possibleLeftovers: leftovers ? [12] : [] }
            : { type: "unverifiable" as const },
        ),
      getStopObligations: () =>
        Effect.sync(() => (stopped ? [{ record, block: { ...block, nativeTurnId: "U" } }] : [])),
      clearStopObligation: () =>
        Effect.sync(() => {
          stopped = false;
        }),
    } as unknown as CodexSurvivors.CodexSurvivors["Service"];
    const fences = makeGoalTurnFences({
      client: {} as CodexClient.CodexAppServerClient["Service"],
      service,
      goals: new Map([[block.nativeThreadId, [{ record, block }]]]),
      waiting: new Map(),
      tracked: new Map(),
      scope: yield* Scope.make(),
      onReady: () => Effect.void,
    });
    yield* fences.clearDead();
    assert.isTrue(stopped);
    gone = true;
    yield* fences.clearDead();
    assert.isTrue(stopped, "possible remaining processes must keep the fence");
    leftovers = false;
    yield* fences.clearDead();
    assert.isFalse(stopped);
  }),
);

const resumePersistedFence = (
  status: "completed" | "failed" | "interrupted" | "inProgress" | "missing",
) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("persisted-goal");
    const record = { instanceId: ProviderInstanceId.make("codex"), recordName: "record" };
    const block = { threadId, nativeThreadId: "native-thread" };
    const stop = { ...block, nativeTurnId: "U" };
    let stopped = true;
    let goalBlocked = true;
    let goalStatus = "active";
    const cleared = yield* Deferred.make<void>();
    const reads: Array<string | undefined> = [];
    const service = {
      list: Effect.succeed([]),
      listGoalBlocksByInstance: () => Effect.succeed([{ record, block }]),
      getGoalBlocks: () => Effect.sync(() => (goalBlocked ? [{ record, block }] : [])),
      getStopObligations: () => Effect.sync(() => (stopped ? [{ record, block: stop }] : [])),
      recordStopObligation: () =>
        Effect.sync(() => {
          stopped = true;
        }),
      clearStopObligation: () =>
        Effect.sync(() => {
          stopped = false;
        }),
      clearGoalBlock: () =>
        Effect.sync(() => {
          goalBlocked = false;
        }).pipe(Effect.andThen(Deferred.succeed(cleared, undefined)), Effect.asVoid),
      hasGoalBlock: () => Effect.sync(() => goalBlocked),
      ensureAdmission: (_thread: ThreadId, options?: { readonly allowGoalControl?: boolean }) =>
        stopped || (goalBlocked && !options?.allowGoalControl)
          ? Effect.fail(
              new CodexDetachedAppServerError({ detail: stopped ? "stop fence" : "goal block" }),
            )
          : Effect.void,
    } as unknown as CodexSurvivors.CodexSurvivors["Service"];
    const handlers = new Map<string, (payload: unknown) => Effect.Effect<void>>();
    const client = {
      setRequestGuard: () => Effect.void,
      handleServerNotification: (
        method: string,
        handler: (payload: unknown) => Effect.Effect<void>,
      ) =>
        Effect.sync(() => {
          handlers.set(method, handler);
        }),
      request: (method: string, params: { cursor?: string }) =>
        Effect.sync(() => {
          if (method === "thread/goal/get") return { goal: { status: goalStatus } };
          reads.push(params.cursor);
          return params.cursor
            ? { data: status === "missing" ? [] : [{ id: "U", status }], nextCursor: null }
            : { data: [{ id: "T", status: "completed" }], nextCursor: "next" };
        }),
      raw: { request: () => Effect.succeed({}) },
    } as unknown as CodexClient.CodexAppServerClient["Service"];
    const hooks = yield* makeSurvivorNotifications({
      client,
      survivors: Option.some(service),
      instanceId: record.instanceId,
      scope: yield* Scope.Scope,
    });
    yield* hooks.handleNotification("thread/goal/updated", () => Effect.void);
    const pauseAdmission = {
      survivors: Option.some(service),
      settings: yield* ServerSettings.ServerSettingsService.pipe(
        Effect.provide(ServerSettings.layerTest()),
      ),
      driver: ProviderDriverKind.make("codex"),
      threadId,
      projectId: ProjectId.make("project-goal-fence"),
      message: { text: "/goal pause" },
      settle: () => Effect.void,
    };
    assert.isTrue(yield* refuseCodexAdmission(pauseAdmission));
    yield* hooks.resumeGoalThreads;
    assert.deepEqual(reads, [undefined, "next"]);
    const terminal = status === "completed" || status === "failed" || status === "interrupted";
    assert.equal(stopped, !terminal);
    const refused = yield* refuseCodexAdmission(pauseAdmission);
    assert.equal(refused, !terminal);
    if (!terminal) return;
    assert.isTrue(goalBlocked);
    assert.equal((yield* Effect.exit(service.ensureAdmission(threadId)))._tag, "Failure");
    goalStatus = "paused";
    yield* handlers.get("thread/goal/updated")!({
      threadId: block.nativeThreadId,
      goal: { status: "paused" },
    });
    yield* Deferred.await(cleared);
    yield* service.ensureAdmission(threadId);
  }).pipe(Effect.scoped);

it.effect.each(["completed", "failed", "interrupted", "inProgress", "missing"] as const)(
  "resume reconciles persisted goal turn with %s history",
  (status) => resumePersistedFence(status),
);
