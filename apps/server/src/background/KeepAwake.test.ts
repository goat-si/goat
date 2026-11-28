import createRecoveryIndexes from "../persistence/Migrations/OrchestrationV2/RecoveryIndexes.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, type OrchestrationV2StoredEvent } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as SqlClient from "effect/sql/SqlClient";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as Settings from "../serverSettings.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as KeepAwake from "./KeepAwake.ts";

describe("KeepAwake.holdWhileWanted", () => {
  it.effect("leaves an idle host alone and releases the hold when the server scope ends", () =>
    Effect.gen(function* () {
      const wanted = yield* Queue.unbounded<boolean>();
      const transitions = yield* Queue.unbounded<"held" | "released">();
      const hold = Effect.acquireRelease(Queue.offer(transitions, "held"), () =>
        Queue.offer(transitions, "released"),
      ).pipe(Effect.andThen(Effect.never), Effect.scoped);

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* KeepAwake.holdWhileWanted(Stream.fromQueue(wanted), hold).pipe(Effect.forkScoped);
          yield* Queue.offer(wanted, false);
          yield* TestClock.adjust("120 seconds");
          expect(yield* Queue.size(transitions)).toBe(0);
          yield* Queue.offer(wanted, true);
          expect(yield* Queue.take(transitions)).toBe("held");
        }),
      );

      expect(yield* Queue.take(transitions)).toBe("released");
    }),
  );

  it.effect("keeps one hold across a gap shorter than the grace and releases after it", () =>
    Effect.gen(function* () {
      const wanted = yield* Queue.unbounded<boolean>();
      const transitions = yield* Queue.unbounded<"held" | "released">();
      const hold = Effect.acquireRelease(Queue.offer(transitions, "held"), () =>
        Queue.offer(transitions, "released"),
      ).pipe(Effect.andThen(Effect.never), Effect.scoped);
      yield* KeepAwake.holdWhileWanted(Stream.fromQueue(wanted), hold, "60 seconds").pipe(
        Effect.forkScoped,
      );

      yield* Queue.offer(wanted, true);
      expect(yield* Queue.take(transitions)).toBe("held");

      yield* Queue.offer(wanted, false);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(wanted, true);
      yield* TestClock.adjust("120 seconds");
      expect(yield* Queue.size(transitions)).toBe(0);

      yield* Queue.offer(wanted, false);
      yield* TestClock.adjust("120 seconds");
      expect(yield* Queue.take(transitions)).toBe("released");
      expect(yield* Queue.size(transitions)).toBe(0);
    }),
  );

  it.effect(
    "upgrades from idle to display, downgrades back to idle, and releases display after grace or on disable",
    () =>
      Effect.gen(function* () {
        const wanted = yield* Queue.unbounded<KeepAwake.KeepAwakeWanted>();
        const transitions = yield* Queue.unbounded<string>();
        const hold = (level: KeepAwake.KeepAwakeAssertion) =>
          Effect.acquireRelease(Queue.offer(transitions, `held:${level}`), () =>
            Queue.offer(transitions, `released:${level}`),
          ).pipe(Effect.andThen(Effect.never), Effect.scoped);
        yield* KeepAwake.holdWhileWanted(Stream.fromQueue(wanted), hold, "60 seconds").pipe(
          Effect.forkScoped,
        );

        yield* Queue.offer(wanted, "idle");
        expect(yield* Queue.take(transitions)).toBe("held:idle");

        yield* Queue.offer(wanted, "display");
        expect(yield* Queue.take(transitions)).toBe("released:idle");
        expect(yield* Queue.take(transitions)).toBe("held:display");

        yield* Queue.offer(wanted, "idle");
        expect(yield* Queue.take(transitions)).toBe("released:display");
        expect(yield* Queue.take(transitions)).toBe("held:idle");

        yield* Queue.offer(wanted, "display");
        expect(yield* Queue.take(transitions)).toBe("released:idle");
        expect(yield* Queue.take(transitions)).toBe("held:display");

        yield* Queue.offer(wanted, false);
        yield* TestClock.adjust("30 seconds");
        expect(yield* Queue.size(transitions)).toBe(0);
        yield* TestClock.adjust("30 seconds");
        expect(yield* Queue.take(transitions)).toBe("released:display");

        yield* Queue.offer(wanted, "display");
        expect(yield* Queue.take(transitions)).toBe("held:display");
        yield* Queue.offer(wanted, "disabled");
        expect(yield* Queue.take(transitions)).toBe("released:display");
        expect(yield* Queue.size(transitions)).toBe(0);
      }),
  );
});

const runChanged = {
  sequence: 1,
  commandId: null,
  event: { type: "run.updated" },
} as OrchestrationV2StoredEvent;

const setupWatcher = Effect.fn("test.setupKeepAwake")(function* (
  enabled = true,
  spawnerOverride?: ChildProcessSpawner.ChildProcessSpawner["Service"],
  options?: {
    readonly platform?: NodeJS.Platform;
    readonly desktopControlActive?: Stream.Stream<boolean>;
    readonly hasInitialRun?: boolean;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_projection_runs(status TEXT, thread_id TEXT)`;
  if (options?.hasInitialRun !== false) {
    yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('running', 'fixture')`;
  }
  const settings = yield* Queue.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
  const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const transitions = yield* Queue.unbounded<"held" | "released">();
  const spawnedCommands = yield* Queue.unbounded<{
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  }>();
  const cursorReads = yield* Ref.make(0);
  const subscriptions = yield* Ref.make(0);
  const fakeSpawner = ChildProcessSpawner.make((command) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        if (command._tag === "StandardCommand") {
          yield* Queue.offer(spawnedCommands, {
            command: command.command,
            args: command.args.map((arg) => (typeof arg === "string" ? arg : String(arg))),
          });
        }
        yield* Queue.offer(transitions, "held");
      }),
      () => Queue.offer(transitions, "released"),
    ).pipe(
      Effect.as(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      ),
    ),
  );
  const baseDeps = Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawnerOverride ?? fakeSpawner),
    Layer.succeed(SqlClient.SqlClient, sql),
    Layer.succeed(HostProcess.Platform, options?.platform ?? "darwin"),
    Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
      latestApplicationSequence: Ref.update(cursorReads, (n) => n + 1).pipe(Effect.as(0)),
      streamApplicationEvents: () =>
        Stream.unwrap(
          Effect.acquireRelease(
            Ref.update(subscriptions, (n) => n + 1),
            () => Ref.update(subscriptions, (n) => n - 1),
          ).pipe(Effect.as(Stream.fromQueue(events))),
        ),
    }),
    Layer.mock(Settings.ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        keepAwakeWhileAgentsWork: enabled,
      }),
      subscribeChanges: Effect.succeed(Stream.fromQueue(settings)),
    }),
  );
  const deps =
    options?.desktopControlActive === undefined
      ? baseDeps
      : Layer.merge(
          baseDeps,
          Layer.mock(ComputerUseLeases.ComputerUseLeases)({
            desktopControlActive: options.desktopControlActive,
            proxy: undefined,
          }),
        );
  yield* Layer.build(KeepAwake.layer.pipe(Layer.provide(deps)));
  return { sql, transitions, spawnedCommands, settings, events, cursorReads, subscriptions };
});

const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect.each(["disable", "failed read"] as const)(
  "releases a running inhibitor immediately on %s",
  (reason) =>
    Effect.gen(function* () {
      const h = yield* setupWatcher();
      expect(yield* Queue.take(h.transitions)).toBe("held");
      if (reason === "disable") {
        yield* Queue.offer(h.settings, {
          ...DEFAULT_SERVER_SETTINGS,
          keepAwakeWhileAgentsWork: false,
        });
      } else {
        yield* h.sql`DROP TABLE orchestration_v2_projection_runs`;
        yield* Queue.offer(h.events, runChanged);
      }
      expect(yield* Queue.take(h.transitions)).toBe("released");
    }).pipe(Effect.provide(sqlite)),
);

it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "reaps an inhibitor that ignores TERM",
  () =>
    Effect.gen(function* () {
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const options = yield* Deferred.make<ChildProcess.Command>();
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(options, command);
          if (command._tag !== "StandardCommand" || command.options.forceKillAfter === undefined)
            return yield* Effect.die("inhibitor has no termination bound");
          const child = yield* realSpawner.spawn(
            ChildProcess.make(
              process.execPath,
              ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
              { ...command.options, stdout: "pipe" },
            ),
          );
          yield* child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead);
          yield* Deferred.succeed(spawned, child);
          return child;
        }),
      );
      const child = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* setupWatcher(true, spawner);
          const command = yield* Deferred.await(options);
          expect(
            command._tag === "StandardCommand" && command.options.forceKillAfter,
          ).toBeDefined();
          return yield* Deferred.await(spawned);
        }),
      );
      expect(yield* child.isRunning).toBe(false);
    }).pipe(Effect.provide(Layer.mergeAll(sqlite, NodeServices.layer))),
);

it.effect("seeks the recovery partial index for the active-run snapshot", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_events(stream_id TEXT, application_event_version INT, aggregate_kind TEXT, event_type TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_runs(status TEXT, thread_id TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_runtime_requests(thread_id TEXT, status TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT, type TEXT, status TEXT)`;
    yield* createRecoveryIndexes;
    const plan = yield* sql.unsafe<{ detail: string }>(
      "EXPLAIN QUERY PLAN " + KeepAwake.ACTIVE_RUN_SNAPSHOT_SQL,
    );
    expect(plan.map((row) => row.detail)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /SEARCH .* USING COVERING INDEX orchestration_v2_projection_runs_recovery_idx/,
        ),
      ]),
    );
  }).pipe(Effect.provide(sqlite)),
);

it.effect("takes its first activity snapshot when keep-awake is enabled", () =>
  Effect.gen(function* () {
    const h = yield* setupWatcher(false);
    yield* TestClock.adjust("1 second");
    expect(yield* Ref.get(h.cursorReads)).toBe(0);
    yield* Queue.offer(h.settings, DEFAULT_SERVER_SETTINGS);
    expect(yield* Queue.take(h.transitions)).toBe("held");
    expect(yield* Ref.get(h.cursorReads)).toBe(1);
    yield* Queue.offer(h.settings, { ...DEFAULT_SERVER_SETTINGS, keepAwakeWhileAgentsWork: false });
    expect(yield* Queue.take(h.transitions)).toBe("released");
    expect(yield* Ref.get(h.subscriptions)).toBe(0);
  }).pipe(Effect.provide(sqlite)),
);

it.effect(
  "upgrades macOS caffeinate to display-awake while desktop computer use is active and downgrades when it ends",
  () =>
    Effect.gen(function* () {
      const desktopControlActive = yield* Queue.unbounded<boolean>();
      const h = yield* setupWatcher(true, undefined, {
        platform: "darwin",
        desktopControlActive: Stream.fromQueue(desktopControlActive),
      });

      expect(yield* Queue.take(h.transitions)).toBe("held");
      expect(yield* Queue.take(h.spawnedCommands)).toEqual({
        command: "caffeinate",
        args: ["-i", "-w", String(process.pid)],
      });

      yield* Queue.offer(desktopControlActive, true);
      expect(yield* Queue.take(h.transitions)).toBe("released");
      expect(yield* Queue.take(h.transitions)).toBe("held");
      expect(yield* Queue.take(h.spawnedCommands)).toEqual({
        command: "caffeinate",
        args: ["-d", "-i", "-w", String(process.pid)],
      });

      yield* Queue.offer(desktopControlActive, false);
      expect(yield* Queue.take(h.transitions)).toBe("released");
      expect(yield* Queue.take(h.transitions)).toBe("held");
      expect(yield* Queue.take(h.spawnedCommands)).toEqual({
        command: "caffeinate",
        args: ["-i", "-w", String(process.pid)],
      });

      yield* h.sql`DELETE FROM orchestration_v2_projection_runs`;
      yield* Queue.offer(h.events, runChanged);
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("60 seconds");
      expect(yield* Queue.take(h.transitions)).toBe("released");
    }).pipe(Effect.provide(sqlite)),
);

it.effect("uses display execution state flags on Windows when desktop computer use is active", () =>
  Effect.gen(function* () {
    const desktopControlActive = yield* Queue.unbounded<boolean>();
    const h = yield* setupWatcher(true, undefined, {
      platform: "win32",
      desktopControlActive: Stream.fromQueue(desktopControlActive),
    });

    expect(yield* Queue.take(h.transitions)).toBe("held");
    const idleCommand = yield* Queue.take(h.spawnedCommands);
    expect(idleCommand.command).toBe("powershell.exe");
    expect(idleCommand.args.join(" ")).toContain("[uint32]2147483649");

    yield* Queue.offer(desktopControlActive, true);
    expect(yield* Queue.take(h.transitions)).toBe("released");
    expect(yield* Queue.take(h.transitions)).toBe("held");
    const displayCommand = yield* Queue.take(h.spawnedCommands);
    expect(displayCommand.command).toBe("powershell.exe");
    expect(displayCommand.args.join(" ")).toContain("[uint32]2147483651");
  }).pipe(Effect.provide(sqlite)),
);

it.effect("holds systemd-inhibit on Linux for both idle turns and desktop computer use", () =>
  Effect.gen(function* () {
    const desktopControlActive = yield* Queue.unbounded<boolean>();
    const h = yield* setupWatcher(true, undefined, {
      platform: "linux",
      desktopControlActive: Stream.fromQueue(desktopControlActive),
      hasInitialRun: false,
    });

    yield* Queue.offer(desktopControlActive, true);
    expect(yield* Queue.take(h.transitions)).toBe("held");
    const displayCommand = yield* Queue.take(h.spawnedCommands);
    expect(displayCommand.command).toBe("systemd-inhibit");
    expect(displayCommand.args).toContain("--what=idle:sleep");

    yield* Queue.offer(desktopControlActive, false);
    yield* TestClock.adjust("1 second");
    yield* TestClock.adjust("60 seconds");
    expect(yield* Queue.take(h.transitions)).toBe("released");
  }).pipe(Effect.provide(sqlite)),
);
