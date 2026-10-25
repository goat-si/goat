import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  BUILTIN_PERMISSION_PROFILES,
  FleetOwnerKey,
  type HostStatusEntry,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
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
import Migration0087 from "../../persistence/Migrations/091_FleetHealth.ts";
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
}

const newWorld = (): World => ({
  reachable: { A: true, B: true },
  threads: [{ host: "A", threadId: ThreadId.make("thread:a1"), title: "Worker", phase: "running" }],
  launches: [],
  calls: [],
  appliedInterrupts: new Set(),
  oldHosts: new Set(),
  failing: new Set(),
  loseNextLaunchResponse: false,
  noCeilingHosts: new Set(),
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
        yield* authorize;
        world.calls.push({ host: call.host, tool: call.tool, args: { ...call.arguments } });
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
const withServer = <A, E>(
  world: World,
  filename: string,
  body: Effect.Effect<A, E, Services>,
  power?: Layer.Layer<HostPowerMonitor.HostPowerMonitor>,
) => body.pipe(Effect.provide(layerFor(world, filename, power)));

const databaseFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return path.join(
    yield* fs.makeTempDirectoryScoped({ prefix: "goat-fleet-health-" }),
    "state.sqlite",
  );
}).pipe(Effect.provide(NodeServices.layer));

const ref = { host: "A", threadId: ThreadId.make("thread:a1"), watchId: null };

const request = (
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
const observe = (minutes: number, target = ref) =>
  Effect.gen(function* () {
    const health = yield* Health.Health;
    let last = yield* health.threadHealth(target);
    for (let minute = 0; minute < minutes; minute += 1) {
      yield* TestClock.adjust(Duration.minutes(1));
      last = yield* health.threadHealth(target);
    }
    return last;
  });

const loseA = (world: World) =>
  Effect.gen(function* () {
    world.reachable.A = false;
    expect((yield* observe(9))._tag).toBe("host_lost");
  });

const testScoped = <A, E>(
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

describe("Rescheduler", () => {
  it.effect(
    "resumes work from a Lost host on another host exactly once, across a lost answer and a restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const filename = yield* databaseFile;
          yield* withServer(
            world,
            filename,
            Effect.gen(function* () {
              const rescheduler = yield* Rescheduler.Rescheduler;
              // The fake answers with real payloads, so a running attempt reads healthy.
              expect(yield* observe(0)).toEqual({ _tag: "healthy", idle: false });
              world.reachable.A = false;
              expect((yield* observe(3))._tag).toBe("unknown");
              expect(yield* rescheduler.reschedule(request())).toMatchObject({
                reason: "host_still_answers",
              });
              expect((yield* observe(5))._tag).toBe("host_lost");
              world.loseNextLaunchResponse = true;
              expect(yield* rescheduler.reschedule(request())).toMatchObject({
                _tag: "Refused",
                reason: "no_capacity",
              });
              expect(world.launches).toHaveLength(1);
            }),
          );
          // After a restart the claim points at B, and the retry adopts the thread found there.
          yield* withServer(
            world,
            filename,
            Effect.gen(function* () {
              const rescheduler = yield* Rescheduler.Rescheduler;
              const first = yield* rescheduler.reschedule(request());
              const again = yield* rescheduler.reschedule(request());
              expect(first).toEqual({
                _tag: "Rescheduled",
                host: "B",
                threadId: "thread:B1",
                branch: "goal-g1-s0-a2",
                resumedFrom: "branch",
              });
              expect(again).toEqual(first);
              expect(world.launches).toHaveLength(1);
            }),
          );
          const launch = world.launches[0]!;
          expect(launch).toMatchObject({
            host: "B",
            cwd: "/repo",
            title: Rescheduler.attemptTitle("goal:g1", "goal:g1:s0:a2:launch", "goal-g1-s0-a2"),
            runtimeMode: "full-access",
            workspace: {
              type: "worktree",
              branch: "goal-g1-s0-a2",
              baseRef: "goal-g1-s0-a1",
              startFromOrigin: true,
            },
          });
          expect(launch.message).toContain("Ship the thing.");
          expect(launch.message).toContain("GOAT moved this work from thread thread:a1 on A");
        }),
      ),
  );

  testScoped("never launches elsewhere while an earlier launch's host cannot be checked", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      world.reachable.C = true;
      yield* loseA(world);
      world.loseNextLaunchResponse = true;
      const first = yield* rescheduler.reschedule(request({ targetHost: "B" }));
      expect(first).toMatchObject({ reason: "no_capacity" });
      // B now fails its thread list: the outcome there is unknown, so C gets nothing.
      world.failing.add("B/goat_thread_list");
      expect(yield* rescheduler.reschedule(request())).toMatchObject({ reason: "no_capacity" });
      expect(world.launches.map((launch) => launch.host)).toEqual(["B"]);
      world.failing.delete("B/goat_thread_list");
      expect(yield* rescheduler.reschedule(request())).toMatchObject({
        _tag: "Rescheduled",
        host: "B",
        threadId: "thread:B1",
      });
      expect(world.launches).toHaveLength(1);
    }),
  );

  testScoped(
    "regression #1451: a held move whose answer was lost stays unconfirmed until findMove sees its thread",
    (world) =>
      Effect.gen(function* () {
        const rescheduler = yield* Rescheduler.Rescheduler;
        const held = request({
          holdUnconfirmed: true,
          callerRuntimeMode: "full-access",
          runtimeMode: "auto",
        });
        yield* loseA(world);
        // Nothing was claimed yet, so nothing can have launched.
        expect(
          yield* rescheduler.findMove({ clientRequestId: held.clientRequestId, owner: held.owner }),
        ).toEqual({ _tag: "NotLaunched" });
        world.loseNextLaunchResponse = true;
        expect(yield* rescheduler.reschedule(held)).toMatchObject({
          _tag: "Unconfirmed",
          host: "B",
        });
        expect(world.launches[0]).toMatchObject({
          runtimeMode: "auto",
          callerRuntimeMode: "full-access",
        });
        // B cannot be listed: unknown, and a retry launches nothing anywhere.
        world.failing.add("B/goat_thread_list");
        expect(
          yield* rescheduler.findMove({ clientRequestId: held.clientRequestId, owner: held.owner }),
        ).toMatchObject({ _tag: "Unknown", host: "B" });
        expect(yield* rescheduler.reschedule(held)).toMatchObject({
          _tag: "Unconfirmed",
          host: "B",
        });
        // Another owner's lookup never adopts it.
        expect(
          yield* rescheduler.findMove({
            clientRequestId: held.clientRequestId,
            owner: FleetOwnerKey.make("goal:other"),
          }),
        ).toMatchObject({ _tag: "Unknown" });
        world.failing.delete("B/goat_thread_list");
        expect(
          yield* rescheduler.findMove({ clientRequestId: held.clientRequestId, owner: held.owner }),
        ).toEqual({ _tag: "Launched", host: "B", threadId: "thread:B1", branch: "goal-g1-s0-a2" });
        expect(yield* rescheduler.reschedule(held)).toMatchObject({
          _tag: "Rescheduled",
          host: "B",
        });
        expect(world.launches).toHaveLength(1);
      }),
  );

  testScoped(
    "regression #1451: a held move never relaunches when its earlier launch is not listed",
    (world) =>
      Effect.gen(function* () {
        const rescheduler = yield* Rescheduler.Rescheduler;
        const held = request({ holdUnconfirmed: true });
        yield* loseA(world);
        world.loseNextLaunchResponse = true;
        expect(yield* rescheduler.reschedule(held)).toMatchObject({ _tag: "Unconfirmed" });
        // The launch has not appeared there (yet): a person's retry would relaunch on B; a held one waits.
        world.threads.splice(
          world.threads.findIndex((thread) => thread.host === "B"),
          1,
        );
        expect(yield* rescheduler.reschedule(held)).toMatchObject({
          _tag: "Unconfirmed",
          host: "B",
        });
        expect(
          yield* rescheduler.findMove({ clientRequestId: held.clientRequestId, owner: held.owner }),
        ).toMatchObject({ _tag: "Unknown" });
        expect(world.launches).toHaveLength(1);
      }),
  );

  testScoped("regression #1451: a move never lands on a host the goal excludes", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      world.reachable.C = true;
      yield* loseA(world);
      expect(yield* rescheduler.reschedule(request({ excludeHosts: ["B"] }))).toMatchObject({
        _tag: "Rescheduled",
        host: "C",
      });
    }),
  );

  testScoped("never adopts another owner's thread on the same branch name", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      world.threads.push({
        host: "B",
        threadId: ThreadId.make("thread:other"),
        title: Rescheduler.attemptTitle("goal:other", "goal:g1:s0:a2:launch", "goal-g1-s0-a2"),
        phase: "running",
      });
      yield* loseA(world);
      const moved = yield* rescheduler.reschedule(request());
      expect(moved).toMatchObject({ _tag: "Rescheduled", host: "B", threadId: "thread:B1" });
      expect(world.launches).toHaveLength(1);
    }),
  );

  testScoped("lets placement choose only among the caller's allowed hosts", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      world.reachable.C = true;
      yield* loseA(world);
      // B and C are equally free, and B comes first; a profile limited to C must not land on B.
      const refused = yield* rescheduler.reschedule(request({ allowedHosts: ["A"] }));
      expect(refused).toMatchObject({
        _tag: "Refused",
        reason: "no_capacity",
        message: expect.stringContaining("goatclaw profile allows (A)"),
      });
      expect(world.launches).toEqual([]);
      const moved = yield* rescheduler.reschedule(request({ allowedHosts: ["C"] }));
      expect(moved).toMatchObject({ _tag: "Rescheduled", host: "C" });
      expect(world.launches.map((launch) => launch.host)).toEqual(["C"]);
    }),
  );

  testScoped("keeps an earlier attempt's host to the caller's allowed hosts", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      world.reachable.C = true;
      yield* loseA(world);
      // An earlier caller's launch on B ended without an answer; B now shows no such thread.
      yield* (yield* FleetHostStates.FleetRescheduleClaims).claim({
        clientRequestId: "goal:g1:s0:a2:launch",
        ownerKey: FleetOwnerKey.make("goal:g1"),
        targetHost: "B",
        title: Rescheduler.attemptTitle("goal:g1", "goal:g1:s0:a2:launch", "goal-g1-s0-a2"),
        branch: "goal-g1-s0-a2",
      });
      const refused = yield* rescheduler.reschedule(request({ allowedHosts: ["C"] }));
      expect(refused).toMatchObject({ _tag: "Refused", reason: "not_allowed" });
      expect(world.launches).toEqual([]);
    }),
  );

  testScoped(
    "asks a host remembered as Lost again before moving, and interrupts it when it answers",
    (world) =>
      Effect.gen(function* () {
        const rescheduler = yield* Rescheduler.Rescheduler;
        yield* loseA(world);
        world.reachable.A = true;
        expect(
          yield* rescheduler.reschedule(request({ reason: "stalled", force: true })),
        ).toMatchObject({
          reason: "host_still_answers",
        });
        expect(world.launches).toHaveLength(0);
        expect(world.threads[0]!.phase).toBe("interrupted");
        // Confirmed stopped: now it moves.
        expect(yield* rescheduler.reschedule(request({ reason: "stalled" }))).toMatchObject({
          _tag: "Rescheduled",
        });
      }),
  );

  testScoped("stops when the caller loses its authority while the move waits", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      yield* loseA(world);
      let mode: RuntimeMode = "full-access";
      const authorize = Effect.sync(() => mode);
      mode = "approval-required";
      expect(yield* rescheduler.reschedule(request({ authorize }))).toMatchObject({
        reason: "not_allowed",
      });
      const gone = Effect.fail(
        new Rescheduler.RescheduleNotAllowed({ message: "The launcher thread was archived." }),
      );
      expect(yield* rescheduler.reschedule(request({ authorize: gone }))).toEqual({
        _tag: "Refused",
        reason: "not_allowed",
        message: "The launcher thread was archived.",
      });
      expect(world.launches).toHaveLength(0);
      expect(world.calls.filter((call) => call.tool === "goat_thread_interrupt")).toHaveLength(0);
    }),
  );

  testScoped(
    "regression #1451: the attempt cap follows the goal's maxAttemptsPerWorker; manual moves keep 3",
    (world) =>
      Effect.gen(function* () {
        const rescheduler = yield* Rescheduler.Rescheduler;
        yield* loseA(world);
        const at = (attempt: number, maxAttempts?: number) =>
          rescheduler.reschedule(
            request({
              attempt,
              ...(maxAttempts === undefined ? {} : { maxAttempts }),
              clientRequestId: "goal:g1:s0:a" + (attempt + 1) + ":launch:" + maxAttempts,
              workspace: {
                baseRef: "dev",
                branch: "goal-g1-s0-a" + (attempt + 1) + "-" + maxAttempts,
                startFromOrigin: true,
              },
            }),
          );
        const outcomes = [
          yield* at(1, 1),
          yield* at(2),
          yield* at(3),
          yield* at(9, 10),
          yield* at(10, 10),
        ].map((result) => (result._tag === "Refused" ? result.reason : result._tag));
        // The last legal successor moves; the one after it is refused.
        expect(outcomes).toEqual(["budget", "Rescheduled", "budget", "Rescheduled", "budget"]);
      }),
  );

  testScoped("regression #969: binds the caller's goatclaw ceiling on the destination", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      yield* loseA(world);
      const ceiling = BUILTIN_PERMISSION_PROFILES.worker!;
      const synced: Array<string> = [];
      const moved = yield* rescheduler.reschedule(
        request({
          permissionProfileCeiling: ceiling,
          prepareCeiling: (host) =>
            Effect.sync(() => {
              // The destination's policy is synced before anything launches there.
              expect(world.launches).toHaveLength(0);
              synced.push(host);
            }),
        }),
      );
      expect(moved).toMatchObject({ _tag: "Rescheduled", host: "B" });
      expect(synced).toEqual(["B"]);
      expect(world.launches.map((launch) => launch.permissionProfileCeiling)).toEqual([ceiling]);
    }),
  );

  testScoped(
    "regression #969: refuses a destination that cannot hold the ceiling, then places again",
    (world) =>
      Effect.gen(function* () {
        const rescheduler = yield* Rescheduler.Rescheduler;
        yield* loseA(world);
        world.noCeilingHosts.add("B");
        const bounded = request({ permissionProfileCeiling: BUILTIN_PERMISSION_PROFILES.worker! });
        expect(yield* rescheduler.reschedule(bounded)).toMatchObject({
          _tag: "Refused",
          reason: "unsupported_remote",
          message: expect.stringContaining("permission_profile_unsupported"),
        });
        expect(world.launches).toEqual([]);
        // Nothing launched, so the request is free to place once the destination updates.
        world.noCeilingHosts.delete("B");
        expect(yield* rescheduler.reschedule(bounded)).toMatchObject({
          _tag: "Rescheduled",
          host: "B",
        });
      }),
  );

  testScoped("drains between runs and never interrupts a running turn", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      expect(yield* rescheduler.reschedule(request({ reason: "drain" }))).toMatchObject({
        reason: "host_still_answers",
      });
      expect(world.calls.filter((call) => call.tool === "goat_thread_interrupt")).toHaveLength(0);
      world.threads[0]!.phase = "completed";
      expect(yield* rescheduler.reschedule(request({ reason: "drain" }))).toMatchObject({
        _tag: "Rescheduled",
        host: "B",
      });
    }),
  );

  testScoped("reads an older host's thread through goat_thread_read", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      world.oldHosts.add("A");
      world.threads[0]!.phase = "completed";
      expect(yield* observe(0)).toEqual({ _tag: "healthy", idle: true });
      expect(yield* rescheduler.reschedule(request({ reason: "manual" }))).toMatchObject({
        _tag: "Rescheduled",
      });
      expect(
        world.calls.some((call) => call.host === "A" && call.tool === "goat_thread_read"),
      ).toBe(true);
    }),
  );

  testScoped("treats an unknown host alias as no answer, never as Ready", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      const monitor = yield* HostHealthMonitor.HostHealthMonitor;
      const nowhere = { host: "nowhere", threadId: ThreadId.make("thread:x"), watchId: null };
      expect(
        yield* rescheduler.reschedule(request({ ref: nowhere, reason: "manual" })),
      ).toMatchObject({
        reason: "host_still_answers",
      });
      expect(
        (yield* monitor.conditions("nowhere")).conditions.map((condition) => condition.type),
      ).not.toContain("Ready");
      expect(world.launches).toHaveLength(0);
    }),
  );

  testScoped("respects cordons when placing", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      const states = yield* FleetHostStates.FleetHostStates;
      world.threads[0]!.phase = "completed";
      yield* states.cordon({
        host: "B",
        draining: false,
        reason: "maintenance",
        changedBy: "test",
      });
      expect(yield* rescheduler.reschedule(request({ reason: "manual" }))).toMatchObject({
        reason: "no_capacity",
      });
      yield* states.uncordon("B");
      expect(yield* rescheduler.reschedule(request({ reason: "manual" }))).toMatchObject({
        _tag: "Rescheduled",
        host: "B",
      });
    }),
  );

  testScoped("reports this machine's own quota limits", () =>
    Effect.gen(function* () {
      const monitor = yield* HostHealthMonitor.HostHealthMonitor;
      const local = {
        host: null,
        reachability: "ok",
        metrics: {
          quotas: [
            {
              instanceId: "codex",
              driver: "codex",
              fromCache: false,
              limits: {
                checkedAt: "2026-10-20T00:00:00.000Z",
                windows: [
                  {
                    id: "primary",
                    kind: "weekly",
                    label: "Weekly",
                    usedPercent: 100,
                    resetsAt: "2099-01-01T00:00:00.000Z",
                  },
                ],
              },
            },
          ],
        },
      } as unknown as HostStatusEntry;
      const annotated = yield* monitor.annotate({ hosts: [local] });
      expect(annotated.hosts[0]!.conditions?.map((condition) => condition.type)).toEqual([
        "Ready",
        "QuotaExhausted",
      ]);
    }),
  );

  it.effect("does not count a host as Lost when this machine wakes from an hour of sleep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = newWorld();
        const filename = yield* databaseFile;
        yield* withServer(
          world,
          filename,
          Effect.gen(function* () {
            const monitor = yield* HostHealthMonitor.HostHealthMonitor;
            const rescheduler = yield* Rescheduler.Rescheduler;
            yield* monitor.tick;
            world.reachable.A = false;
            yield* observe(2);
            yield* TestClock.adjust(Duration.minutes(60));
            // The first call after waking can beat the clock source; it must still see the wake.
            expect((yield* (yield* Health.Health).threadHealth(ref))._tag).toBe("unknown");
            for (let minute = 0; minute < 4; minute += 1) {
              yield* TestClock.adjust(Duration.minutes(1));
              expect((yield* (yield* Health.Health).threadHealth(ref))._tag).toBe("unknown");
            }
            expect(yield* rescheduler.reschedule(request())).toMatchObject({
              reason: "host_still_answers",
            });
            world.reachable.A = true;
            expect((yield* observe(1))._tag).toBe("healthy");
            expect(world.launches).toHaveLength(0);
          }),
        );
      }),
    ),
  );

  it.effect(
    "drops failures when the power monitor reports a suspend shorter than the tick gap",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const filename = yield* databaseFile;
          const power = yield* HostPowerMonitor.make();
          const powerLayer = Layer.succeed(HostPowerMonitor.HostPowerMonitor, power);
          yield* withServer(
            world,
            filename,
            Effect.gen(function* () {
              const health = yield* Health.Health;
              world.reachable.A = false;
              // Three failures 30 s apart: Unreachable, with no tick gap long enough to look like sleep.
              for (let step = 0; step < 3; step += 1) {
                yield* TestClock.adjust(Duration.seconds(30));
                yield* health.threadHealth(ref);
              }
              expect(
                (yield* health.hostCondition("A")).conditions.map((condition) => condition.type),
              ).toContain("Unreachable");
              const snapshot = yield* power.snapshot;
              const at = yield* DateTime.now;
              // The power PubSub keeps only the newest change, so let the consumer see each one.
              const settle = Effect.forEach([1, 2, 3, 4], () => Effect.yieldNow, { discard: true });
              yield* power.report({ ...snapshot, suspended: true, stale: false, updatedAt: at });
              yield* settle;
              yield* power.report({ ...snapshot, suspended: false, stale: false, updatedAt: at });
              yield* settle;
              expect(
                (yield* health.hostCondition("A")).conditions.map((condition) => condition.type),
              ).not.toContain("Unreachable");
            }),
            powerLayer,
          );
        }),
      ),
  );

  testScoped(
    "stops a superseded attempt once when its host returns, and fails on a refusal",
    (world) =>
      Effect.gen(function* () {
        const fence = Rescheduler.fenceStaleAttempt({
          ref,
          successorHost: "B",
          successorBranch: "goal-g1-s0-a2",
          clientRequestId: "goal:g1:s0:a1:interrupt",
          authorize: Effect.succeed<RuntimeMode>("full-access"),
        });
        world.reachable.A = false;
        expect((yield* Effect.result(fence))._tag).toBe("Failure");
        world.reachable.A = true;
        yield* fence;
        yield* fence;
        const interrupts = world.calls.filter(
          (call) => call.host === "A" && call.tool === "goat_thread_interrupt",
        );
        expect(new Set(interrupts.map((call) => call.args.clientRequestId))).toEqual(
          new Set(["goal:g1:s0:a1:interrupt"]),
        );
        expect(String(interrupts[1]!.args.reason)).toContain(
          "continues on B on branch goal-g1-s0-a2",
        );
        expect(world.appliedInterrupts.size).toBe(1);
        expect(
          world.calls.some((call) => call.host === "A" && call.tool === "goat_thread_send"),
        ).toBe(false);
      }),
  );
});
