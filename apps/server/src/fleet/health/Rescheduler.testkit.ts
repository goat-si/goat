/** The hosts, dispatch and server the Rescheduler's integration tests run against. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { FleetOwnerKey, type HostStatusEntry, type RuntimeMode, ThreadId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as HostPowerMonitor from "../../background/HostPowerMonitor.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import Migration0087 from "../../persistence/Migrations/092_FleetHealth.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import { Placement, PlacementHostConditions } from "../resources/Placement.ts";
import { place } from "../resources/placementRules.ts";
import * as FleetHostStates from "./FleetHostStates.ts";
import * as Health from "./Health.ts";
import * as HostHealthMonitor from "./HostHealthMonitor.ts";
import { layerPlacementConditions } from "./layer.ts";
import * as Rescheduler from "./Rescheduler.ts";

interface RemoteThread {
  readonly host: string;
  readonly threadId: ThreadId;
  readonly title: string;
  phase: string;
}

interface World {
  readonly reachable: Record<string, boolean>;
  readonly threads: Array<RemoteThread>;
  readonly launches: Array<SshRemoteDispatch.SshLaunchInput>;
  readonly calls: Array<{
    readonly host: string;
    readonly tool: string;
    readonly args: Record<string, unknown>;
    /** The session ceiling the call ran under. */
    readonly ceiling?: RuntimeMode;
  }>;
  /** Interrupts the remote applied, by clientRequestId, as a GOAT server dedupes them. */
  readonly appliedInterrupts: Set<string>;
  /** Hosts whose GOAT predates goat_thread_status. */
  readonly oldHosts: Set<string>;
  /** Tools that fail on a host although it answers other calls. */
  readonly failing: Set<string>;
  /** The next launch creates its thread, then the answer is lost (SSH dropped mid-call). */
  loseNextLaunchResponse: boolean;
  /** Hosts whose GOAT cannot bind a goatclaw ceiling to a launched thread. */
  readonly noCeilingHosts: Set<string>;
  /** Interrupts land, but their answer is lost. */
  loseInterruptAnswers: boolean;
  /** Branches never pushed: a destination cannot start a worktree from them. */
  readonly unpushed: Set<string>;
}

export const newWorld = (): World => ({
  reachable: { A: true, B: true },
  threads: [{ host: "A", threadId: ThreadId.make("thread:a1"), title: "Worker", phase: "running" }],
  launches: [],
  calls: [],
  appliedInterrupts: new Set(),
  oldHosts: new Set(),
  failing: new Set(),
  loseNextLaunchResponse: false,
  noCeilingHosts: new Set(),
  loseInterruptAnswers: false,
  unpushed: new Set(),
});

const unavailable = (host: string) =>
  new SshRemoteDispatch.SshRemoteDispatchError({
    reason: "host_unavailable",
    message: host + " did not answer",
  });

const refusedBy = (message: string) =>
  new SshRemoteDispatch.SshRemoteDispatchError({ reason: "remote_refused", message });

/**
 * Answers the way SshRemoteDispatch.callHostTool does: the tool's payload itself, and a refusal
 * (including an older GOAT's missing tool) as a remote_refused error.
 */
const fakeDispatch = (world: World) =>
  ({
    connectedHosts: Effect.sync(() => Object.keys(world.reachable)),
    callHostTool: (
      call: SshRemoteDispatch.SshHostToolCall,
      authorize: Effect.Effect<RuntimeMode, Rescheduler.RescheduleNotAllowed>,
    ) =>
      Effect.gen(function* () {
        const ceiling = yield* authorize;
        world.calls.push({
          host: call.host,
          tool: call.tool,
          args: { ...call.arguments },
          ceiling,
        });
        if (call.host === "nowhere") {
          return yield* new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "host_unknown",
            message: "No SSH host nowhere.",
          });
        }
        if (world.reachable[call.host] !== true) return yield* unavailable(call.host);
        if (world.failing.has(call.host + "/" + call.tool)) return yield* unavailable(call.host);
        const thread = world.threads.find(
          (candidate) =>
            candidate.host === call.host && candidate.threadId === call.arguments.threadId,
        );
        const now = DateTime.formatIso(yield* DateTime.now);
        switch (call.tool) {
          case "goat_thread_status":
            if (world.oldHosts.has(call.host)) {
              return yield* refusedBy(
                "GOAT on " +
                  call.host +
                  " " +
                  SshRemoteDispatch.REMOTE_THREAD_STATUS_UNSUPPORTED +
                  ".",
              );
            }
            if (thread === undefined) return yield* refusedBy("thread_not_found");
            return {
              threadId: thread.threadId,
              title: thread.title,
              phase: thread.phase,
              terminal: thread.phase !== "running",
              run: {
                runId: "run:1",
                status: thread.phase,
                requestedAt: now,
                startedAt: now,
                completedAt: null,
              },
              queuedRunId: null,
              pendingRequest: null,
              lastActivityAt: now,
              lastMessage: null,
              lastError: null,
              watch: null,
            };
          case "goat_thread_read":
            if (thread === undefined) return yield* refusedBy("thread_not_found");
            return {
              thread: {
                threadId: thread.threadId,
                projectId: "project",
                title: thread.title,
                createdBy: "agent",
                creationSource: "mcp",
                status: thread.phase,
                latestRunId: "run:1",
                activeRunId: thread.phase === "running" ? "run:1" : null,
                providerInstanceId: "codex",
                model: "gpt-6.1-sol",
                runtimeMode: "full-access",
                interactionMode: "default",
                linkedPullRequest: null,
                pullRequests: [],
                titleRegeneration: null,
                branch: "goal-g1-s0-a1",
                worktreePath: "/repo",
                parentThreadId: null,
                relationshipToParent: null,
                runCount: 1,
                itemCount: 0,
                pendingRequestCount: 0,
                archived: false,
                settled: false,
                settledAt: null,
                snoozed: false,
                snoozedUntil: null,
                createdAt: now,
                updatedAt: now,
              },
              recentRuns: [
                {
                  runId: "run:1",
                  ordinal: 1,
                  status: thread.phase,
                  providerInstanceId: "codex",
                  model: "gpt-6.1-sol",
                  requestedAt: now,
                  startedAt: now,
                  completedAt: thread.phase === "running" ? null : now,
                },
              ],
              items: [],
              nextPosition: null,
              hasMore: false,
            };
          case "goat_thread_interrupt": {
            const id = String(call.arguments.clientRequestId);
            if (!world.appliedInterrupts.has(id) && thread !== undefined)
              thread.phase = "interrupted";
            world.appliedInterrupts.add(id);
            if (world.loseInterruptAnswers)
              return yield* new SshRemoteDispatch.SshRemoteDispatchError({
                reason: "host_unavailable",
                message: "the connection dropped before the answer",
              });
            return {
              threadId: call.arguments.threadId,
              runId: null,
              status: "interrupt_requested",
            };
          }
          case "goat_thread_list":
            return {
              threads: world.threads
                .filter(
                  (entry) =>
                    entry.host === call.host &&
                    entry.title.includes(String(call.arguments.titleContains)),
                )
                .map((entry) => ({ threadId: entry.threadId, title: entry.title })),
            };
          default:
            return {};
        }
      }),
    launchThread: (
      input: SshRemoteDispatch.SshLaunchInput,
      beforeLaunch: Effect.Effect<void, Rescheduler.RescheduleNotAllowed>,
    ) =>
      Effect.gen(function* () {
        yield* beforeLaunch;
        const host = input.host ?? "local";
        if (world.reachable[host] !== true) return yield* unavailable(host);
        if (input.permissionProfileCeiling !== undefined && world.noCeilingHosts.has(host))
          return yield* new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "remote_refused",
            remoteCode: "permission_profile_unsupported",
            message: "Remote GOAT cannot preserve a permission profile ceiling.",
          });
        const baseRef = input.workspace?.type === "worktree" ? input.workspace.baseRef : null;
        if (baseRef != null && world.unpushed.has(baseRef))
          return yield* new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "remote_refused",
            remoteCode: "invalid_request",
            message:
              'Base ref "' +
              baseRef +
              '" does not resolve to a commit in project "repo" (/home/me/.goat/worktrees/repo). No thread was created.',
          });
        world.launches.push(input);
        const threadId = ThreadId.make("thread:" + host + world.launches.length);
        world.threads.push({ host, threadId, title: input.title, phase: "running" });
        if (world.loseNextLaunchResponse) {
          world.loseNextLaunchResponse = false;
          return yield* new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "host_unavailable",
            message: "the connection dropped before the answer",
            launchMayHaveStarted: true,
          });
        }
        return {
          host,
          cwd: input.cwd,
          projectId: "project",
          projectCreated: false,
          threadId,
          reportsSupported: false,
          runId: null,
          workspaceStrategy: { type: "worktree" },
          runtimeMode: input.runtimeMode,
          remoteServerKind: null,
          notes: [],
        };
      }),
  }) as unknown as SshRemoteDispatch.SshRemoteDispatch["Service"];

const probeOf = (world: World) => (host: string) =>
  Effect.sync((): HostStatusEntry =>
    world.reachable[host] === true
      ? { host, reachability: "ok", serverVersion: "1" }
      : { host, reachability: "unreachable", message: host + " timed out" },
  );

/** T3 placement over the fake hosts, with its real rules and the cordons this layer provides. */
const fakePlacement = (world: World) =>
  Layer.succeed(
    Placement,
    Placement.of({
      place: (input) =>
        Effect.gen(function* () {
          const cordoned = yield* (yield* PlacementHostConditions).cordoned;
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const hosts = Object.entries(world.reachable).map(([host, up]): HostStatusEntry =>
            up
              ? ({
                  host,
                  reachability: "ok",
                  serverVersion: "1",
                  metrics: {
                    threads: { running: 0, waiting: 0, queued: 0 },
                    quotas: [
                      {
                        instanceId: "codex",
                        driver: "codex",
                        fromCache: false,
                        limits: { checkedAt: "2026-10-20T00:00:00.000Z", windows: [] },
                      },
                    ],
                  },
                } as unknown as HostStatusEntry)
              : { host, reachability: "unreachable", message: host + " timed out" },
          );
          return place(
            {
              owner: input.owner,
              selections: [input.modelSelection],
              hostSelector: input.hostSelector,
              avoidHosts: input.avoidHosts,
              cordoned,
            },
            hosts,
            {},
            now,
          );
        }),
      status: Effect.die("unused"),
      statusOf: () => Effect.die("unused"),
    }),
  );

/** A fresh server over one database file: host contacts start empty, cordons and claims persist. */
const layerFor = (
  world: World,
  filename: string,
  power?: Layer.Layer<HostPowerMonitor.HostPowerMonitor>,
) =>
  Layer.mergeAll(Health.layer, Rescheduler.layer).pipe(
    Layer.provideMerge(fakePlacement(world)),
    Layer.provideMerge(layerPlacementConditions),
    Layer.provideMerge(
      Layer.effect(
        HostHealthMonitor.HostHealthMonitor,
        HostHealthMonitor.make({ probe: probeOf(world) }),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(FleetHostStates.layer, FleetHostStates.layerClaims)),
    Layer.provideMerge(
      // A restart reopens the same file; the tables already exist then.
      Layer.effectDiscard(Effect.ignore(Migration0087)).pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename })),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(SshRemoteDispatch.SshRemoteDispatch, fakeDispatch(world)),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        power ?? Layer.empty,
      ),
    ),
  );

type Services = Layer.Success<ReturnType<typeof layerFor>>;
export const withServer = <A, E>(
  world: World,
  filename: string,
  body: Effect.Effect<A, E, Services>,
  power?: Layer.Layer<HostPowerMonitor.HostPowerMonitor>,
) => body.pipe(Effect.provide(layerFor(world, filename, power)));

export const databaseFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return path.join(
    yield* fs.makeTempDirectoryScoped({ prefix: "goat-fleet-health-" }),
    "state.sqlite",
  );
}).pipe(Effect.provide(NodeServices.layer));

export const ref = { host: "A", threadId: ThreadId.make("thread:a1"), watchId: null };

export const request = (
  overrides: Partial<Rescheduler.RescheduleRequest> = {},
): Rescheduler.RescheduleRequest => ({
  ref,
  owner: FleetOwnerKey.make("goal:g1"),
  attempt: 1,
  reason: "host_unreachable",
  modelSelection: { instanceId: "codex" as never, model: "gpt-6.1-sol" },
  workspace: { baseRef: "dev", branch: "goal-g1-s0-a2", startFromOrigin: true },
  previousBranch: "goal-g1-s0-a1",
  replica: null,
  prompt: "Ship the thing.",
  runtimeMode: "full-access",
  clientRequestId: "goal:g1:s0:a2:launch",
  project: { cwd: "/repo", canonicalKey: null },
  ...overrides,
});

/** Thread health reads, a minute apart, as the controller makes them; each is a host contact. */
export const observe = (minutes: number, target = ref) =>
  Effect.gen(function* () {
    const health = yield* Health.Health;
    let last = yield* health.threadHealth(target);
    for (let minute = 0; minute < minutes; minute += 1) {
      yield* TestClock.adjust(Duration.minutes(1));
      last = yield* health.threadHealth(target);
    }
    return last;
  });

export const loseA = (world: World) =>
  Effect.gen(function* () {
    world.reachable.A = false;
    expect((yield* observe(9))._tag).toBe("host_lost");
  });

export const testScoped = <A, E>(
  name: string,
  body: (world: World, filename: string) => Effect.Effect<A, E, Services>,
) =>
  it.effect(name, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = newWorld();
        const filename = yield* databaseFile;
        yield* withServer(world, filename, body(world, filename));
      }),
    ),
  );
