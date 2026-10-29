import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID, type TerminalEvent, type TerminalOpenInput } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";
import { FakePtyAdapter, FakePtyProcess } from "./Manager.testkit.ts";

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

interface CreateManagerOptions {
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  subprocessInspector?: (terminalPid: number) => Effect.Effect<{
    readonly hasRunningSubprocess: boolean;
    readonly childCommand: string | null;
    readonly processIds: ReadonlyArray<number>;
  }>;
  processTable?: Effect.Effect<
    ReadonlyArray<{ readonly pid: number; readonly ppid: number; readonly name: string }>,
    never
  >;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  registerTerminalProcesses?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["registerTerminalProcesses"];
  maxRetainedInactiveSessions?: number;
  historyByteLimit?: number;
  ptyAdapter?: FakePtyAdapter;
  resolveProviderInstanceEnvironment?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["resolveProviderInstanceEnvironment"];
  managedBinaryCacheDir?: string;
  managedBinaryToolsDir?: string;
}

interface ManagerFixture {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly ptyAdapter: FakePtyAdapter;
  readonly manager: TerminalManager.TerminalManager["Service"];
  readonly getEvents: Effect.Effect<ReadonlyArray<TerminalEvent>>;
}

const createManager = (
  historyLineLimit = 5,
  options: CreateManagerOptions = {},
): Effect.Effect<
  ManagerFixture,
  PlatformError.PlatformError,
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope
  | ProcessRunner.ProcessRunner
  | McpProviderSessions.McpProviderSessions
> =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-terminal-" });
      const logsDir = join(baseDir, "userdata", "logs", "terminals");
      const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();

      const manager = yield* TerminalManager.makeWithOptions({
        logsDir,
        historyLineLimit,
        ptyAdapter,
        ...(options.historyByteLimit !== undefined
          ? { historyByteLimit: options.historyByteLimit }
          : {}),
        ...(options.shellResolver !== undefined ? { shellResolver: options.shellResolver } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.subprocessInspector !== undefined
          ? { subprocessInspector: options.subprocessInspector }
          : {}),
        ...(options.processTable !== undefined ? { processTable: options.processTable } : {}),
        ...(options.subprocessPollIntervalMs !== undefined
          ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
          : {}),
        processKillGraceMs: options.processKillGraceMs ?? 1,
        ...(options.registerTerminalProcesses !== undefined
          ? { registerTerminalProcesses: options.registerTerminalProcesses }
          : {}),
        ...(options.maxRetainedInactiveSessions !== undefined
          ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
          : {}),
        ...(options.resolveProviderInstanceEnvironment !== undefined
          ? { resolveProviderInstanceEnvironment: options.resolveProviderInstanceEnvironment }
          : {}),
        ...(options.managedBinaryCacheDir === undefined
          ? {}
          : {
              managedBinaryCacheDir: options.managedBinaryCacheDir,
              managedBinaryToolsDir: options.managedBinaryToolsDir,
            }),
      });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(eventsRef, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      return {
        baseDir,
        logsDir,
        join,
        ptyAdapter,
        manager,
        getEvents: Ref.get(eventsRef),
      };
    }),
  );

const publishPastOutputBudget = (
  manager: TerminalManager.TerminalManager["Service"],
  process: FakePtyProcess,
) =>
  Effect.gen(function* () {
    const published = yield* Deferred.make<void>();
    const unsubscribe = yield* manager.subscribe((event) =>
      event.type === "output" && event.data === "last\n"
        ? Deferred.succeed(published, undefined).pipe(Effect.asVoid)
        : Effect.void,
    );
    for (let index = 0; index < 9; index++) process.emitData("x".repeat(1024 * 1024));
    process.emitData("last\n");
    yield* Deferred.await(published);
    unsubscribe();
  });

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    McpProviderSessions.layer,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  ),
  { excludeTestServices: true },
)("Terminal grid", (it) => {
  it.effect("attached viewers jointly own the grid and ignore unattached resizes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const stopWide = yield* manager.attachStream(
        openInput({ cols: 130, rows: 12 }),
        () => Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(stopWide));
      const stopNarrow = yield* manager.attachStream(
        openInput({ cols: 54, rows: 20 }),
        () => Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(stopNarrow));
      const process = ptyAdapter.processes[0]!;
      expect(process.resizeCalls.at(-1)).toEqual({ cols: 54, rows: 12 });
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 200,
        rows: 50,
      });
      expect(process.resizeCalls.at(-1)).toEqual({ cols: 54, rows: 12 });
    }),
  );

  it.effect("restores the remaining viewer's grid after a resized viewer detaches", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const restored = yield* Deferred.make<void>();
      const wide = yield* manager.attachStream(
        openInput({ cols: 130, rows: 15 }),
        (event) =>
          event.type === "activity" && event.cols === 130 && event.rows === 15
            ? Deferred.succeed(restored, undefined).pipe(Effect.asVoid)
            : Effect.void,
        undefined,
        "wide",
      );
      yield* Effect.addFinalizer(() => Effect.sync(wide));
      const phone = yield* manager.attachStream(
        openInput({ cols: 54, rows: 15 }),
        () => Effect.void,
        undefined,
        "phone",
      );
      yield* manager.resize(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, cols: 100, rows: 15 },
        "phone",
      );
      const retry = yield* manager.attachStream(
        { ...openInput({ cols: 54, rows: 15 }), resume: true },
        () => Effect.void,
        undefined,
        "phone",
      );
      expect(ptyAdapter.processes[0]!.resizeCalls.at(-1)).toEqual({ cols: 100, rows: 15 });
      retry();
      phone();
      yield* Deferred.await(restored);
      expect(ptyAdapter.processes[0]!.resizeCalls.at(-1)).toEqual({ cols: 130, rows: 15 });
    }),
  );

  it.effect("retains viewer ownership through an overflow until its stream ends", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const restored = yield* Deferred.make<void>();
      const wide = yield* manager.attachStream(
        openInput({ cols: 130, rows: 15 }),
        (event) =>
          event.type === "activity" && event.cols === 130 && event.rows === 15
            ? Deferred.succeed(restored, undefined).pipe(Effect.asVoid)
            : Effect.void,
        undefined,
        "wide",
      );
      yield* Effect.addFinalizer(() => Effect.sync(wide));
      const process = ptyAdapter.processes[0]!;
      yield* Effect.gen(function* () {
        const pull = yield* Stream.toPull(
          manager.attachOutputStream(openInput({ cols: 54, rows: 15 }), "phone"),
        );
        expect(yield* pull).toMatchObject([{ type: "snapshot" }]);
        yield* publishPastOutputBudget(manager, process);
        yield* manager.resize(
          { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, cols: 50, rows: 12 },
          "phone",
        );
        expect(process.resizeCalls.at(-1)).toEqual({ cols: 50, rows: 12 });
        expect(yield* pull).toMatchObject([{ type: "snapshot" }]);
      }).pipe(Effect.scoped);
      yield* Deferred.await(restored);
      expect(process.resizeCalls.at(-1)).toEqual({ cols: 130, rows: 15 });
    }).pipe(Effect.scoped),
  );
});
