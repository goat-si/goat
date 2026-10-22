import { describe, expect, it } from "@effect/vitest";
import type {
  FleetSettings,
  HostPressure,
  HostStatusEntry,
  OrchestrationV2ServerCommand,
  OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as HostStatusMcpService from "../../mcp/HostStatusMcpService.ts";
import type { LaunchWatch } from "../../mcp/launchWatch.ts";
import * as LaunchWatchService from "../../mcp/LaunchWatchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as HostPressureMonitor from "./HostPressureMonitor.ts";
import * as PressureNudger from "./PressureNudger.ts";

const MIN = 60_000;

const pressure = (level: HostPressure["level"], since = 0): HostPressure => ({
  level,
  since: DateTime.formatIso(DateTime.makeUnsafe(since)),
  reasons:
    level === "ok"
      ? []
      : [
          {
            signal: "load",
            level,
            message: level === "critical" ? "load 6.2 per core" : "load 2 per core",
          },
        ],
  loadPerCore: level === "critical" ? 6.2 : 0.2,
  eventLoopDelayMs: null,
});

const entry = (
  host: string | null,
  level: HostPressure["level"],
  running = 0,
): HostStatusEntry => ({
  host,
  reachability: "ok",
  pressure: pressure(level),
  metrics: {
    sampledAt: 0,
    cpuUtilization: 0.1,
    cpuCount: 10,
    availableMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    loadAvg: { oneMinute: level === "critical" ? 62 : 1, fiveMinutes: 0, fifteenMinutes: 0 },
    disk: null,
    threads: { running, waiting: 0, queued: 0 },
    quotas: [],
  },
});

const shell = (
  id: string,
  options: { readonly running?: boolean; readonly launchedBy?: string } = {},
): OrchestrationV2ThreadShell =>
  ({
    id,
    title: id,
    status: options.running === true ? "running" : "idle",
    activityRunStatus: options.running === true ? "running" : null,
    archivedAt: null,
    deletedAt: null,
    worktreePath: null,
    branch: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    ...(options.launchedBy === undefined
      ? {}
      : {
          launchedBy: {
            kind: "launch",
            threadId: options.launchedBy,
            environmentId: null,
            environmentLabel: null,
            threadTitle: null,
          },
        }),
  }) as unknown as OrchestrationV2ThreadShell;

interface World {
  local: HostPressure | undefined;
  remote: Array<HostStatusEntry>;
  shells: Array<OrchestrationV2ThreadShell>;
  watches: Array<LaunchWatch>;
  commands: Array<OrchestrationV2ServerCommand>;
}

const makeWorld = (): World => ({
  local: undefined,
  remote: [entry("macmini", "ok")],
  shells: [
    shell("person"),
    shell("manager", { launchedBy: "person" }),
    shell("vitest-lane", { running: true, launchedBy: "manager" }),
  ],
  watches: [],
  commands: [],
});

const layer = (world: World, fleet: FleetSettings = {}) =>
  Layer.effect(PressureNudger.PressureNudger, PressureNudger.make).pipe(
    Layer.provideMerge(PressureNudger.layerAdmission),
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.ServerSettingsService.layerTest({ fleet }),
        Layer.succeed(HostPressureMonitor.HostPressureMonitor, {
          current: Effect.sync(() => world.local),
          sample: Effect.sync(() => world.local),
        }),
        Layer.mock(HostStatusMcpService.HostStatusMcpService)({
          readForClient: () =>
            Effect.sync(() => ({
              hosts: [
                ...(world.local === undefined
                  ? []
                  : [{ ...entry(null, world.local.level, 8), pressure: world.local }]),
                ...world.remote,
              ],
            })),
        }),
        Layer.mock(LaunchWatchService.LaunchWatchService)({
          listRemote: () => Effect.sync(() => world.watches),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          listProjectThreads: () => Effect.sync(() => world.shells),
          dispatch: (command) =>
            Effect.sync(() => {
              world.commands.push(command);
              return { sequence: world.commands.length } as never;
            }),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({ environmentId: "env-local" } as never),
        }),
      ),
    ),
  );

const tick = Effect.flatMap(PressureNudger.PressureNudger, (nudger) => nudger.tick);

/** Each command as "<thread> <wake|notice>: <first line>". */
const sent = (world: World) =>
  world.commands
    .splice(0)
    .map((command) =>
      command.type === "message.dispatch"
        ? command.threadId + " wake: " + command.text.split("\n")[0]
        : command.type === "thread.notice.record"
          ? command.threadId + " notice: " + command.message.split("\n")[0]
          : command.type,
    );

describe("PressureNudger.tick", () => {
  it.effect("wakes the threads orchestrating local work, once per level and cooldown", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      world.local = pressure("critical");
      yield* tick;
      const first = world.commands.slice();
      expect(sent(world)).toEqual([
        "manager wake: Resource pressure: this machine is critical (since 1970-01-01T00:00:00.000Z).",
        "person wake: Resource pressure: this machine is critical (since 1970-01-01T00:00:00.000Z).",
      ]);
      const text = first[0]?.type === "message.dispatch" ? first[0].text : "";
      expect(text).toContain('"vitest-lane" (threadId vitest-lane, started by this thread)');
      expect(text).toContain("- macmini: load 0.1 per core, 0 threads running or queued");
      expect(text).toContain("start the next ones on macmini with goat_ssh_thread_launch");

      yield* TestClock.adjust(MIN);
      yield* tick;
      expect(sent(world)).toEqual([]);

      world.local = pressure("ok", 2 * MIN);
      yield* TestClock.adjust(MIN);
      yield* tick;
      expect(sent(world)).toEqual([
        "manager notice: Resource pressure: this machine is back to normal load. Heavy lanes can run there again; check goat_host_status before starting several at once.",
        "person notice: Resource pressure: this machine is back to normal load. Heavy lanes can run there again; check goat_host_status before starting several at once.",
      ]);

      // Critical again three minutes after the first notice: inside the 15-minute cooldown.
      world.local = pressure("critical", 3 * MIN);
      yield* TestClock.adjust(MIN);
      yield* tick;
      expect(sent(world)).toEqual([]);

      world.local = pressure("ok", 4 * MIN);
      yield* TestClock.adjust(MIN);
      yield* tick;
      world.local = pressure("critical", 20 * MIN);
      yield* TestClock.adjust(16 * MIN);
      yield* tick;
      expect(sent(world)).toEqual([
        "manager wake: Resource pressure: this machine is critical (since 1970-01-01T00:20:00.000Z).",
        "person wake: Resource pressure: this machine is critical (since 1970-01-01T00:20:00.000Z).",
      ]);
    }).pipe(Effect.provide(layer(world)));
  });

  it.effect("records elevated as a notice and follows remote hosts its threads watch", () => {
    const world = makeWorld();
    world.watches = [
      {
        id: "w1",
        incarnation: "i",
        launcherThreadId: "manager",
        owner: null,
        ceiling: null,
        host: "macbook",
        threadId: "remote-lane",
        projectId: null,
        title: "knip",
        pendingRuns: ["run-1"],
        reportedRuns: [],
        reportedQuestions: [],
        lastEpisode: 0,
        outage: null,
        deliveryAttempts: {},
        notifyWebhook: false,
        webhookTarget: null,
        armedAt: 0,
        createdAt: 0,
        updatedAt: 0,
      } as unknown as LaunchWatch,
    ];
    world.remote = [entry("macbook", "elevated"), entry("macmini", "ok")];
    world.local = pressure("ok");
    return Effect.gen(function* () {
      yield* tick;
      expect(sent(world)).toEqual([
        "manager notice: Resource pressure: macbook is elevated (since 1970-01-01T00:00:00.000Z).",
        "person notice: Resource pressure: macbook is elevated (since 1970-01-01T00:00:00.000Z).",
      ]);
    }).pipe(Effect.provide(layer(world)));
  });

  it.effect("stays quiet when pressure is turned off or delivery is off", () => {
    const world = makeWorld();
    world.local = pressure("critical");
    return Effect.gen(function* () {
      yield* tick;
      expect(sent(world)).toEqual([]);
    }).pipe(Effect.provide(layer(world, { pressure: { criticalDelivery: "off" } })));
  });
});

describe("PressureNudger.admit", () => {
  it.effect("advises a launch onto a critical host and refuses it only under block", () => {
    const world = makeWorld();
    world.local = pressure("critical");
    return Effect.gen(function* () {
      const nudger = yield* PressureNudger.PressureNudger;
      yield* nudger.observe({ hosts: world.remote });
      const admission = yield* nudger.admit(null);
      expect(admission.refuse).toBe(true);
      expect(admission.advice?.alternatives).toEqual(["macmini"]);
      expect(admission.advice?.message).toBe(
        "this machine is under critical resource pressure (load 6.2 per core). Keep heavy work (installs, browser test suites, typechecks) off it. Hosts with room: macmini.",
      );
      expect(yield* nudger.admit("macmini")).toEqual({ advice: undefined, refuse: false });
    }).pipe(Effect.provide(layer(world, { pressure: { admission: "block" } })));
  });
});

it.effect("constructs admission without watch or host-status services", () =>
  Effect.gen(function* () {
    const admission = yield* PressureNudger.PressureAdmissionService;
    expect((yield* admission.admit(null)).refuse).toBe(true);
  }).pipe(
    Effect.provide(
      PressureNudger.layerAdmission.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({ fleet: { pressure: { admission: "block" } } }),
            Layer.succeed(HostPressureMonitor.HostPressureMonitor, {
              current: Effect.succeed(pressure("critical")),
              sample: Effect.succeed(pressure("critical")),
            }),
          ),
        ),
      ),
    ),
  ),
);

it.effect("shares remote readings between launch admission and the notification service", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const nudger = yield* PressureNudger.PressureNudger;
    const admission = yield* PressureNudger.PressureAdmissionService;
    yield* nudger.observe({ hosts: [entry("macmini", "critical")] });
    expect((yield* admission.admit("macmini")).refuse).toBe(true);
    yield* admission.observe({ hosts: [entry("macmini", "ok")] });
    expect((yield* nudger.admit("macmini")).refuse).toBe(false);
  }).pipe(Effect.provide(layer(world, { pressure: { admission: "block" } })));
});
