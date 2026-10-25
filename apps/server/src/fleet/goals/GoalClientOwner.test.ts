import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type AuthEnvironmentScope,
  type AuthSessionId,
  EnvironmentId,
  type FleetGoal,
  FleetGoalId,
  OrchestratorMcpFailure,
  RunId,
} from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import * as McpClientAuthority from "../../auth/McpClientAuthority.ts";
import { MCP_CLIENT_SUBJECT } from "../../auth/mcpClientSubject.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Profiles from "../../goatclaw/PermissionProfiles.ts";
import * as HostThreadsMcpService from "../../mcp/HostThreadsMcpService.ts";
import * as LaunchWatchService from "../../mcp/LaunchWatchService.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadLaunchMcpService from "../../mcp/ThreadLaunchMcpService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as FleetDefaults from "../defaults.ts";
import { Health } from "../health/Health.ts";
import { Fallback } from "../resources/Fallback.ts";
import { Placement } from "../resources/Placement.ts";
import { GoalController, layer as controllerLayer } from "./GoalController.ts";
import { GoalRecovery } from "./GoalRecovery.ts";
import { GoalStore, layer as goalStoreLayer, NOT_SENT } from "./GoalStore.ts";
import { testGoal, testSpec } from "./goalTestkit.ts";
import { layer as runtimeLayer, workerThreadId } from "./GoalWorkerRuntime.ts";

/**
 * A goal owned by an outside MCP client, end to end through the real session store, the
 * client-authority loader, the worker runtime, the controller and the goal store, over one
 * database file so a second build of every layer is a server restart. Only the thread services
 * at the edge are fakes, and no launch watch or webhook exists: the controller follows its
 * workers itself.
 */

interface World {
  /** Thread shells that exist, by id. */
  readonly threads: Map<string, ReturnType<typeof liveThreadShell>>;
  readonly launches: Array<{
    readonly threadId: string;
    readonly sessionId: string | undefined;
    readonly thread: unknown;
    readonly notifyOnCompletion: unknown;
    readonly runtimeMode: string;
  }>;
  readonly dispatched: Array<string>;
  readonly observed: Array<{ readonly threadId: string; readonly sessionId: string | undefined }>;
  /** Whether the worker's run has ended without a report. */
  ended: boolean;
  /** Runs once inside the next launch, before ThreadLaunchService would hand anything over. */
  duringLaunch: Effect.Effect<void> | null;
}

const makeWorld = (): World => ({
  threads: new Map(),
  launches: [],
  dispatched: [],
  observed: [],
  ended: false,
  duringLaunch: null,
});

const edge = (world: World) =>
  Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(world.threads.get(threadId) ?? null),
      assertReviewTaskSendAllowed: () => Effect.void,
      dispatch: (command) =>
        Effect.sync(() => {
          world.dispatched.push(command.commandId);
          return {} as never;
        }),
    }),
    Layer.mock(ThreadLaunchMcpService.ThreadLaunchMcpService)({
      launch: (scope: McpInvocationScope, input, modes, stable) =>
        Effect.gen(function* () {
          const before = world.duringLaunch ?? Effect.void;
          world.duringLaunch = null;
          yield* before;
          // What ThreadLaunchService asks right before it hands the thread's creation over.
          if (stable?.confirm !== undefined && !(yield* stable.confirm))
            return yield* new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The launcher may no longer start this work.",
            });
          const threadId = stable!.threadId!;
          world.threads.set(
            threadId,
            liveThreadShell(threadId, { runtimeMode: modes.runtimeMode }),
          );
          world.launches.push({
            threadId,
            sessionId: scope.client?.sessionId,
            thread: scope.thread,
            notifyOnCompletion: input.notifyOnCompletion,
            runtimeMode: modes.runtimeMode,
          });
          return {
            threadId,
            projectId: input.projectId!,
            modelSelection: input.modelSelection!,
            runId: RunId.make("run:1"),
            status: null,
            watching: false,
            standingInstructionsVersion: null,
          };
        }),
    }),
    Layer.mock(HostThreadsMcpService.HostThreadsMcpService)({
      threadStatus: (scope, input) =>
        Effect.sync(() => {
          world.observed.push({ threadId: input.threadId, sessionId: scope.client?.sessionId });
          return {
            terminal: world.ended,
            run: { runId: RunId.make("run:1"), status: world.ended ? "completed" : "running" },
            lastActivityAt: null,
          } as never;
        }),
      readThread: () => Effect.succeed({ result: null } as never),
    }),
    // Webhooks are off and nothing registers a watch: any call here fails the test.
    Layer.mock(LaunchWatchService.LaunchWatchService)({}),
    Layer.mock(PullRequestService.PullRequestService)({}),
    Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({}),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed({ environmentId: EnvironmentId.make("env:test") } as never),
    }),
  );

const fleet = Layer.mergeAll(
  Layer.succeed(Placement, {
    place: (request) =>
      Effect.succeed({
        _tag: "Placed" as const,
        host: null,
        modelSelection: request.modelSelection,
        reason: undefined,
      }),
    status: Effect.die("unused"),
    statusOf: () => Effect.die("unused"),
  }),
  Layer.succeed(Health, {
    hostCondition: (host) => Effect.succeed({ host, conditions: [], observedAt: "" }),
    threadHealth: () => Effect.succeed({ _tag: "healthy" as const }),
  }),
  Layer.succeed(Fallback, {
    next: () => Effect.succeed({ _tag: "Exhausted" as const, reason: "No chain." }),
    reportFailure: () => Effect.void,
    cooldowns: Effect.succeed([]),
    coversThreads: Effect.succeed(false),
    continueThread: () => Effect.succeed(false),
  }),
  Layer.succeed(GoalRecovery, {
    capture: () => Effect.void,
    resume: () => Effect.succeed({ _tag: "Start" as const, workspace: null, note: null }),
    forget: () => Effect.void,
  }),
  FleetDefaults.layerRescheduler,
);

/** One server: every layer built fresh over the database file at `path`. */
const server = (world: World, path: string) => {
  const database = SqlitePersistence.layerFromPath(path).pipe(Layer.provide(NodeServices.layer));
  const settings = ServerSettings.ServerSettingsService.layerTest({
    fleet: { controllerEnabled: true },
  });
  const sessions = SessionStore.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env:test")),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goal-client-owner-" })),
  );
  return controllerLayer.pipe(
    Layer.provide(
      runtimeLayer.pipe(
        Layer.provide(McpClientAuthority.layer),
        Layer.provide(Profiles.layer),
        Layer.provide(edge(world)),
      ),
    ),
    Layer.provide(fleet),
    Layer.provideMerge(goalStoreLayer),
    Layer.provideMerge(sessions),
    Layer.provide(settings),
    Layer.provideMerge(database),
    Layer.provide(NodeServices.layer),
  );
};

const OPERATE: ReadonlyArray<AuthEnvironmentScope> = [
  "orchestration:read",
  "orchestration:operate",
];

const issue = (scopes: ReadonlyArray<AuthEnvironmentScope> = OPERATE, ttl?: Duration.Duration) =>
  SessionStore.SessionStore.pipe(
    Effect.flatMap((sessions) =>
      sessions.issue({
        subject: MCP_CLIENT_SUBJECT,
        method: "bearer-access-token",
        scopes,
        runtimeModeCeiling: "full-access",
        ...(ttl === undefined ? {} : { ttl }),
      }),
    ),
    Effect.map((issued) => issued.sessionId),
  );

const clientGoal = (id: string, sessionId: string): FleetGoal =>
  testGoal(id, {
    owner: {
      kind: "mcp_client",
      threadId: null,
      mcpOwner: "client:" + sessionId,
      runtimeModeCeiling: "full-access",
    },
    spec: testSpec({ workers: { ...testSpec().workers, runtimeMode: "auto-accept-edits" } }),
  });

const insert = (goal: FleetGoal) =>
  GoalStore.pipe(
    Effect.flatMap((store) => store.create(goal, goal.owner.mcpOwner ?? "", null)),
    Effect.orDie,
  );

const pass = (id: string) =>
  Effect.gen(function* () {
    const store = yield* GoalStore;
    const record = yield* store.get(FleetGoalId.make(id)).pipe(Effect.orDie);
    return yield* (yield* GoalController).reconcile(record!, 10);
  });

const blockedReason = (id: string) =>
  GoalStore.pipe(
    Effect.flatMap((store) => store.get(FleetGoalId.make(id))),
    Effect.orDie,
    Effect.map(
      (record) =>
        record!.goal.status.conditions.find((c) => c.type === "Blocked" && c.status === "True")
          ?.reason,
    ),
  );

const tempDatabase = FileSystem.FileSystem.pipe(
  Effect.flatMap((fs) => fs.makeTempDirectoryScoped()),
  Effect.map((directory) => directory + "/state.sqlite"),
  Effect.provide(NodeServices.layer),
);

describe("a fleet goal owned by an outside MCP client (#493)", () => {
  it.effect(
    "launches as the client, follows its worker across a restart, and stops when revoked",
    () =>
      Effect.gen(function* () {
        const path = yield* tempDatabase;
        const world = makeWorld();
        const sessionId = yield* Effect.gen(function* () {
          const sessionId = yield* issue();
          yield* insert(clientGoal("goal_bot", sessionId));
          yield* pass("goal_bot");
          return sessionId;
        }).pipe(Effect.provide(server(world, path)));
        const workerId = workerThreadId("goal:goal_bot:s0:a1:launch");
        expect(world.launches).toEqual([
          {
            threadId: workerId,
            sessionId,
            thread: undefined,
            notifyOnCompletion: false,
            runtimeMode: "auto-accept-edits",
          },
        ]);

        // A restart: the session's grant is rebuilt from its id in the database; the worker is
        // found again and observed as the client, and no second worker starts.
        yield* Effect.gen(function* () {
          yield* pass("goal_bot");
          expect(world.launches).toHaveLength(1);
          expect(world.observed.at(-1)).toEqual({ threadId: workerId, sessionId });

          // Revoked: the run ended without a report, but no follow-up goes out.
          world.ended = true;
          yield* (yield* SessionStore.SessionStore).revoke(sessionId as AuthSessionId);
          const observedBefore = world.observed.length;
          yield* pass("goal_bot");
          expect(world.dispatched).toEqual([]);
          expect(world.observed).toHaveLength(observedBefore);
          expect(yield* blockedReason("goal_bot")).toBe("OwnerAuthorityLost");
        }).pipe(Effect.provide(server(world, path)));
      }).pipe(Effect.scoped),
  );

  it.effect("dispatches nothing for an expired, unknown or under-scoped session", () =>
    Effect.gen(function* () {
      const path = yield* tempDatabase;
      const world = makeWorld();
      yield* Effect.gen(function* () {
        const expiring = yield* issue(OPERATE, Duration.minutes(1));
        const reader = yield* issue(["orchestration:read"]);
        yield* insert(clientGoal("goal_expired", expiring));
        yield* insert(clientGoal("goal_unknown", "session:never-issued"));
        yield* insert(clientGoal("goal_reader", reader));
        yield* TestClock.adjust(Duration.minutes(2));
        for (const id of ["goal_expired", "goal_unknown", "goal_reader"]) {
          yield* pass(id);
          expect(yield* blockedReason(id), id).toBe("OwnerAuthorityLost");
        }
        expect(world.launches).toEqual([]);
        expect(world.dispatched).toEqual([]);
      }).pipe(Effect.provide(server(world, path)));
    }).pipe(Effect.scoped),
  );

  it.effect("sends nothing when the session is revoked after the launch was claimed", () =>
    Effect.gen(function* () {
      const path = yield* tempDatabase;
      const world = makeWorld();
      yield* Effect.gen(function* () {
        const sessionId = yield* issue();
        const sessions = yield* SessionStore.SessionStore;
        yield* insert(clientGoal("goal_race", sessionId));
        // Claimed and re-read; revoked inside the launch, before the thread would be created.
        world.duringLaunch = sessions
          .revoke(sessionId as AuthSessionId)
          .pipe(Effect.orDie, Effect.asVoid);
        yield* pass("goal_race");
        expect(world.launches).toEqual([]);
        expect(world.threads.size).toBe(0);
        const store = yield* GoalStore;
        const [claim] = yield* store.launches(FleetGoalId.make("goal_race")).pipe(Effect.orDie);
        expect(claim).toMatchObject({ outcome: NOT_SENT });
        expect(yield* blockedReason("goal_race")).toBe("OwnerAuthorityLost");
      }).pipe(Effect.provide(server(world, path)));
    }).pipe(Effect.scoped),
  );
});
