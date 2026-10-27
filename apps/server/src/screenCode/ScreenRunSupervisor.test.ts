// @effect-diagnostics nodeBuiltinImport:off - Real child fixtures stage a local asset under a temporary directory.
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";
import type { EnvironmentId, ThreadId, ProviderInstanceId } from "@goat/contracts";
import { screenRunLimits } from "./ScreenRunLimits.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { ScreenHostBridge } from "./ScreenHostBridge.ts";
import { createScreenRunSupervisor } from "./ScreenRunSupervisor.ts";

const fixtureSupervisor = (input: {
  asset: { path: string; sha256: string };
  limits: ReturnType<typeof screenRunLimits>;
  hostBridge: ScreenHostBridge;
  command?: string;
  scheduleDeadline?: (run: () => void, ms: number) => () => void;
}) =>
  createScreenRunSupervisor({
    asset: input.asset,
    limits: input.limits,
    hostBridge: input.hostBridge,
    ...(input.scheduleDeadline ? { scheduleDeadline: input.scheduleDeadline } : {}),
    invocation: {
      command: input.command ?? process.execPath,
      entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
    },
    // The supervisor callback enters Effect from a child-process event listener.
    // oxlint-disable-next-line goat/no-manual-effect-runtime-in-tests
    runCallback: (effect, signal) => Effect.runPromise(effect, signal ? { signal } : undefined),
  });

// Leaves only the child's own wall limit, so a deadline test never races the supervisor's backstop,
// a timer in another process.
const childDeadlineOnly = () => () => {};

const context = (cellId: string, limits: ReturnType<typeof screenRunLimits>) => ({
  runId: "r",
  turnId: "t",
  cellId,
  threadId: "thread",
  environmentId: "env",
  limits,
  invocation: {
    environmentId: "env" as EnvironmentId,
    capabilities: new Set<"preview">(),
    issuedAt: 0,
    requestNamespace: "test",
    thread: {
      threadId: "thread" as ThreadId,
      providerSessionId: "s",
      providerInstanceId: "p" as ProviderInstanceId,
    },
    client: undefined,
  },
});

it.live("a later cell keeps computation values in the same child", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const asset = yield* resolveScreenRuntimeAsset("dev");
      const limits = screenRunLimits({ cellWallMs: 5000 });
      const bridge = new ScreenHostBridge();
      const supervisor = fixtureSupervisor({ asset, limits, hostBridge: bridge });
      yield* Effect.addFinalizer(() => supervisor.finishTurn("r", "t", "test"));
      const first = yield* supervisor.runCell(
        { runId: "r", turnId: "t", context: context("one", limits) },
        "screen.values.count = 1; return screen.values.count;",
        false,
      );
      const second = yield* supervisor.runCell(
        { runId: "r", turnId: "t", context: context("two", limits) },
        "screen.values.count += 1; return screen.values.count;",
        false,
      );
      expect(first.value).toBe(1);
      expect(second.value).toBe(2);
    }),
  ),
);

it.live("a thrown guest error reports its message and preserves values for the next cell", () =>
  Effect.gen(function* () {
    const asset = yield* resolveScreenRuntimeAsset("dev");
    const limits = screenRunLimits({ cellWallMs: 5000 });
    const supervisor = fixtureSupervisor({ asset, limits, hostBridge: new ScreenHostBridge() });
    const failed = yield* supervisor.runCell(
      { runId: "r", turnId: "t", context: context("throw", limits) },
      "screen.values.count = 3; throw new Error('boom');",
      false,
    );
    expect(failed).toMatchObject({ status: "failed", error: { name: "Error", message: "boom" } });
    const next = yield* supervisor.runCell(
      { runId: "r", turnId: "t", context: context("next", limits) },
      "return screen.values.count;",
      false,
    );
    expect(next.value).toBe(3);
    yield* supervisor.finishTurn("r", "t", "test");
  }),
);

it.live("a multibyte guest error message fits the result contract", () =>
  Effect.gen(function* () {
    const asset = yield* resolveScreenRuntimeAsset("dev");
    const limits = screenRunLimits({ cellWallMs: 5000 });
    const supervisor = fixtureSupervisor({ asset, limits, hostBridge: new ScreenHostBridge() });
    const result = yield* supervisor.runCell(
      { runId: "r", turnId: "t", context: context("message", limits) },
      "throw new Error('한'.repeat(2000));",
      false,
    );
    expect(result.status).toBe("failed");
    expect(
      result.error && "message" in result.error
        ? Buffer.byteLength(result.error.message, "utf8")
        : Infinity,
    ).toBeLessThanOrEqual(1024);
    yield* supervisor.finishTurn("r", "t", "test");
  }),
);

it.live("a later cell may lower its call limit without losing values", () =>
  Effect.gen(function* () {
    const asset = yield* resolveScreenRuntimeAsset("dev");
    const limits = screenRunLimits({ cellWallMs: 5000 });
    const bridge = new ScreenHostBridge();
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () => Effect.succeed({ value: true, category: "confirmed" as const }),
    });
    const supervisor = fixtureSupervisor({ asset, limits, hostBridge: bridge });
    yield* supervisor.runCell(
      { runId: "r", turnId: "t", context: context("first", limits) },
      "screen.values.count = 4; return true;",
      false,
    );
    const lower = screenRunLimits({ cellWallMs: 5000, callsPerCell: 1 });
    const second = yield* supervisor.runCell(
      { runId: "r", turnId: "t", context: context("second", lower) },
      "await screen.list_apps(); return [screen.values.count, await screen.list_apps()];",
      false,
    );
    expect(second.status).toBe("failed");
    expect(second.journal).toHaveLength(1);
    yield* supervisor.finishTurn("r", "t", "test");
  }),
);

it.live("resetValues clears prior computation values", () =>
  Effect.gen(function* () {
    const asset = yield* resolveScreenRuntimeAsset("dev");
    const limits = screenRunLimits({ cellWallMs: 5000 });
    const supervisor = fixtureSupervisor({ asset, limits, hostBridge: new ScreenHostBridge() });
    yield* supervisor.runCell(
      { runId: "r", turnId: "t", context: context("one", limits) },
      "screen.values.count = 1; return 1;",
      false,
    );
    const result = yield* supervisor.runCell(
      { runId: "r", turnId: "t", context: context("two", limits) },
      "return Object.hasOwn(screen.values, 'count');",
      true,
    );
    expect(result.value).toBe(false);
    yield* supervisor.finishTurn("r", "t", "test");
  }),
);

it.live("hung post-cell availability returns within its bound", () =>
  Effect.gen(function* () {
    const asset = yield* resolveScreenRuntimeAsset("dev");
    const limits = screenRunLimits({ cellWallMs: 5000 });
    const bridge = new ScreenHostBridge();
    bridge.setDispatcher({
      availability: () => Effect.never,
      dispatch: () => Effect.succeed({ value: true, category: "confirmed" }),
    });
    const supervisor = fixtureSupervisor({ asset, limits, hostBridge: bridge });
    const result = yield* supervisor.runCell(
      { runId: "r", turnId: "t", context: context("one", limits) },
      "return 7;",
      false,
    );
    expect(result.status).toBe("completed");
    expect(result.value).toBe(7);
    expect(result.availability).toEqual([
      { kind: "app", available: false, reason: "no_lease" },
      { kind: "tab", available: false, reason: "no_host" },
    ]);
    yield* supervisor.finishTurn("r", "t", "test");
  }),
);

it.live("a failed availability read after the result keeps the live child and its values", () =>
  Effect.gen(function* () {
    const asset = yield* resolveScreenRuntimeAsset("dev");
    const limits = screenRunLimits({ cellWallMs: 5000 });
    const bridge = new ScreenHostBridge();
    bridge.setDispatcher({
      availability: () => Effect.die(new Error("availability read failed")),
      dispatch: () => Effect.succeed({ value: true, category: "confirmed" }),
    });
    const supervisor = fixtureSupervisor({ asset, limits, hostBridge: bridge });
    yield* Effect.gen(function* () {
      const first = yield* supervisor.runCell(
        { runId: "r", turnId: "t", context: context("one", limits) },
        "screen.values.kept = 7; return 1;",
        false,
      );
      expect(first.status).toBe("completed");
      expect(first.value).toBe(1);
      expect(first.availability).toEqual([
        { kind: "app", available: false, reason: "no_lease" },
        { kind: "tab", available: false, reason: "no_host" },
      ]);
      expect(supervisor.activeCount()).toBe(1);
      const second = yield* supervisor.runCell(
        { runId: "r", turnId: "t", context: context("two", limits) },
        "return screen.values.kept;",
        false,
      );
      expect(second.value).toBe(7);
    }).pipe(Effect.ensuring(supervisor.finishTurn("r", "t", "test")));
  }),
);

it.live("a deadline stops a queued call before it dispatches and journals it undispatched", () =>
  Effect.gen(function* () {
    const asset = yield* resolveScreenRuntimeAsset("dev");
    const limits = screenRunLimits({ cellWallMs: 1000 });
    const held = yield* Deferred.make<void>();
    const window = {
      id: "window-1",
      kind: "app" as const,
      environmentId: "env",
      runId: "r",
      turnId: "t",
      generation: 1,
    };
    let clicks = 0;
    const bridge = new ScreenHostBridge();
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: (call) =>
        call.method === "bind_app"
          ? Effect.succeed({ value: window, category: "unverifiable" as const })
          : Effect.sync(() => clicks++).pipe(
              Effect.flatMap(() => Deferred.await(held)),
              Effect.as({ value: true, category: "confirmed" as const }),
            ),
    });
    const supervisor = fixtureSupervisor({
      asset,
      limits,
      hostBridge: bridge,
      scheduleDeadline: childDeadlineOnly,
    });
    yield* Effect.gen(function* () {
      // The second click waits behind the first on the window's gate when the deadline hits.
      const result = yield* supervisor.runCell(
        { runId: "r", turnId: "t", context: context("queued", limits) },
        "const app = await screen.app({bundle_id: 'x', window_id: 1}); app.click({x: 1, y: 1}); return await app.click({x: 2, y: 2});",
        false,
      );
      expect(result.status).toBe("deadline");
      expect(supervisor.activeCount()).toBe(1);
      expect(clicks).toBe(1);
      expect(
        result.journal.map((entry) => [entry.receipt.method, entry.receipt.dispatched]),
      ).toEqual([
        ["bind_app", true],
        ["click", true],
        ["click", false],
      ]);
      expect(result.journal.slice(1).map((entry) => entry.receipt.category)).toEqual([
        "unknown_outcome",
        "unknown_outcome",
      ]);
      yield* Deferred.succeed(held, undefined);
    }).pipe(Effect.ensuring(supervisor.finishTurn("r", "t", "test")));
    expect(clicks).toBe(1);
  }),
);

it.live(
  "a Stop while availability is read after the result keeps the result and its receipts",
  () =>
    Effect.gen(function* () {
      const asset = yield* resolveScreenRuntimeAsset("dev");
      const limits = screenRunLimits({ cellWallMs: 5000 });
      const reading = yield* Deferred.make<void>();
      const bridge = new ScreenHostBridge();
      bridge.setDispatcher({
        availability: () => Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never)),
        dispatch: () =>
          Effect.succeed({ value: 4, category: "confirmed", evidence: ["observation:test"] }),
      });
      let fireDeadline: (() => void) | undefined;
      const supervisor = fixtureSupervisor({
        asset,
        limits,
        hostBridge: bridge,
        scheduleDeadline: (run) => {
          fireDeadline = run;
          return () => {
            fireDeadline = undefined;
          };
        },
      });
      const running = yield* Effect.forkChild(
        supervisor.runCell(
          { runId: "r", turnId: "t", context: context("one", limits) },
          "return await screen.list_apps();",
          false,
        ),
      );
      yield* Deferred.await(reading);
      // The result frame cancels the wall timer, so a slow read cannot turn into wall_limit.
      expect(fireDeadline).toBeUndefined();
      yield* supervisor.cutCell("r", "t", "one", "Stop");
      const result = yield* Fiber.join(running);
      expect(result.status).toBe("completed");
      expect(result.value).toBe(4);
      expect(result.journal).toHaveLength(1);
      expect(result.journal[0]?.receipt).toMatchObject({ category: "confirmed" });
      expect(supervisor.activeCount()).toBe(1);
      yield* supervisor.finishTurn("r", "t", "test");
      expect(supervisor.activeCount()).toBe(0);
    }),
);

it.live("sequential awaited host calls settle in order", () =>
  Effect.gen(function* () {
    const asset = yield* resolveScreenRuntimeAsset("dev");
    const limits = screenRunLimits({ cellWallMs: 5000 });
    const bridge = new ScreenHostBridge();
    let count = 0;
    bridge.setDispatcher({
      availability: () => Effect.succeed([{ kind: "app", available: true }]),
      dispatch: () =>
        Effect.succeed({ value: ++count, category: "confirmed", evidence: ["observation:test"] }),
    });
    const supervisor = fixtureSupervisor({ asset, limits, hostBridge: bridge });
    const result = yield* supervisor.runCell(
      { runId: "r", turnId: "t", context: context("one", limits) },
      "let last; for (let i = 0; i < 3; i++) last = await screen.list_apps(); return last;",
      false,
    );
    expect(result.value).toBe(3);
    expect(result.journal).toHaveLength(3);
    yield* supervisor.finishTurn("r", "t", "test");
  }),
);

it.live("a deadline during an awaited host call reports deadline and keeps the child", () =>
  Effect.gen(function* () {
    const asset = yield* resolveScreenRuntimeAsset("dev");
    const limits = screenRunLimits({ cellWallMs: 1000 });
    const offered = yield* Deferred.make<void>();
    const held = yield* Deferred.make<void>();
    const bridge = new ScreenHostBridge();
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () =>
        Deferred.succeed(offered, undefined).pipe(
          Effect.flatMap(() => Deferred.await(held)),
          Effect.as({ value: true, category: "confirmed" as const }),
        ),
    });
    const supervisor = fixtureSupervisor({
      asset,
      limits,
      hostBridge: bridge,
      scheduleDeadline: childDeadlineOnly,
    });
    yield* supervisor.runCell(
      { runId: "r", turnId: "t", context: context("warmup", limits) },
      "return true;",
      false,
    );
    const running = yield* Effect.forkChild(
      supervisor.runCell(
        { runId: "r", turnId: "t", context: context("pending", limits) },
        "return await screen.list_apps();",
        false,
      ),
    );
    yield* Deferred.await(offered);
    const result = yield* Fiber.join(running);
    expect(result.status).toBe("deadline");
    expect(supervisor.activeCount()).toBe(1);
    yield* Deferred.succeed(held, undefined);
    yield* supervisor.finishTurn("r", "t", "test");
  }),
);

it.live("busy loop reaches the child deadline without preserving its turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const asset = yield* resolveScreenRuntimeAsset("dev");
      const limits = screenRunLimits({ cellWallMs: 1000 });
      const supervisor = fixtureSupervisor({
        asset,
        limits,
        hostBridge: new ScreenHostBridge(),
        scheduleDeadline: childDeadlineOnly,
      });
      yield* Effect.addFinalizer(() => supervisor.finishTurn("r", "t", "test"));
      yield* supervisor.runCell(
        { runId: "r", turnId: "t", context: context("warmup", limits) },
        "return true;",
        false,
      );
      const outcome = yield* supervisor
        .runCell(
          { runId: "r", turnId: "t", context: context("one", limits) },
          "while (true) {}",
          false,
        )
        .pipe(Effect.result);
      expect(outcome._tag).toBe("Success");
      if (outcome._tag === "Success") expect(outcome.success.status).toBe("deadline");
    }),
  ),
);

it.live("large allocations stop within the fixed WASM memory cap", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const asset = yield* resolveScreenRuntimeAsset("dev");
      const limits = screenRunLimits({ cellWallMs: 5000 });
      const supervisor = fixtureSupervisor({ asset, limits, hostBridge: new ScreenHostBridge() });
      yield* Effect.addFinalizer(() => supervisor.finishTurn("r", "t", "test"));
      const result = yield* supervisor
        .runCell(
          { runId: "r", turnId: "t", context: context("one", limits) },
          "const parts = []; for (let i = 0; i < 40; i++) parts.push('x'.repeat(4 * 1024 * 1024) + i); return parts.length;",
          false,
        )
        .pipe(Effect.result);
      expect(result._tag).toBe("Success");
      if (result._tag === "Success")
        expect(["resource_exhausted", "failed", "deadline"]).toContain(result.success.status);
    }),
  ),
);

it.live("an Electron-as-Node child loads the staged WASM", () =>
  Effect.gen(function* () {
    const asset = yield* resolveScreenRuntimeAsset("dev");
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-screen-electron-")),
    );
    const staged = NodePath.join(directory, "screen-code/quickjs.wasm");
    const desktopRequire = NodeModule.createRequire(
      new URL("../../../desktop/package.json", import.meta.url),
    );
    const electron = desktopRequire("electron") as string;
    try {
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(staged), { recursive: true }));
      yield* Effect.promise(() => NodeFSP.copyFile(asset.path, staged));
      const limits = screenRunLimits({ cellWallMs: 5000 });
      const supervisor = fixtureSupervisor({
        asset: { path: staged, sha256: asset.sha256 },
        limits,
        hostBridge: new ScreenHostBridge(),
        command: electron,
      });
      yield* Effect.gen(function* () {
        const result = yield* supervisor.runCell(
          { runId: "r", turnId: "t", context: context("one", limits) },
          "return 7;",
          false,
        );
        expect(result.value).toBe(7);
      }).pipe(Effect.ensuring(supervisor.finishTurn("r", "t", "test")));
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }
  }),
);

it.live("Stop kills only the child owned by the cut turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const asset = yield* resolveScreenRuntimeAsset("dev");
      const limits = screenRunLimits({ cellWallMs: 5000 });
      const supervisor = fixtureSupervisor({ asset, limits, hostBridge: new ScreenHostBridge() });
      yield* Effect.addFinalizer(() =>
        Effect.all(
          [supervisor.finishTurn("r1", "t1", "test"), supervisor.finishTurn("r2", "t2", "test")],
          { discard: true },
        ),
      );
      const spinning = yield* Effect.forkChild(
        supervisor
          .runCell(
            {
              runId: "r1",
              turnId: "t1",
              context: { ...context("one", limits), runId: "r1", turnId: "t1" },
            },
            "while (true) {}",
            false,
          )
          .pipe(Effect.result),
      );
      const survivingFirst = yield* supervisor.runCell(
        {
          runId: "r2",
          turnId: "t2",
          context: { ...context("two", limits), runId: "r2", turnId: "t2" },
        },
        "screen.values.count = 9; return screen.values.count;",
        false,
      );
      expect(survivingFirst.value).toBe(9);
      expect(supervisor.activeCount()).toBe(2);
      yield* supervisor.cutCell("r1", "t1", "one", "Stop");
      expect((yield* Fiber.join(spinning))._tag).toBe("Failure");
      const surviving = yield* supervisor.runCell(
        {
          runId: "r2",
          turnId: "t2",
          context: { ...context("two", limits), runId: "r2", turnId: "t2" },
        },
        "return screen.values.count;",
        false,
      );
      expect(surviving.value).toBe(9);
    }),
  ),
);

it.live("an unawaited screen effect does not report a completed cell", () =>
  Effect.gen(function* () {
    const asset = yield* resolveScreenRuntimeAsset("dev");
    const limits = screenRunLimits({ cellWallMs: 5000 });
    const bridge = new ScreenHostBridge();
    bridge.setDispatcher({
      availability: () => Effect.succeed([{ kind: "app", available: true }]),
      dispatch: () => Effect.succeed({ value: true, category: "unverifiable" }),
    });
    const supervisor = fixtureSupervisor({ asset, limits, hostBridge: bridge });
    const result = yield* supervisor.runCell(
      { runId: "r", turnId: "t", context: context("one", limits) },
      "screen.list_apps(); return 1;",
      false,
    );
    expect(result.status).toBe("failed");
    expect(result.journal[0]?.receipt.category).toBe("unknown_outcome");
    yield* supervisor.finishTurn("r", "t", "test");
  }),
);

it.live("interrupting the run fiber cuts its exact child and discards the cell", () =>
  Effect.gen(function* () {
    const asset = yield* resolveScreenRuntimeAsset("dev");
    const limits = screenRunLimits({ cellWallMs: 5000 });
    const bridge = new ScreenHostBridge();
    const started = yield* Deferred.make<void>();
    const blocked = yield* Deferred.make<{ value: boolean; category: "unverifiable" }>();
    bridge.setDispatcher({
      availability: () => Effect.succeed([{ kind: "app", available: true }]),
      dispatch: () =>
        Deferred.succeed(started, undefined).pipe(Effect.flatMap(() => Deferred.await(blocked))),
    });
    const supervisor = fixtureSupervisor({ asset, limits, hostBridge: bridge });
    const fiber = yield* Effect.forkChild(
      supervisor.runCell(
        { runId: "r", turnId: "t", context: context("interrupt", limits) },
        "return await screen.list_apps();",
        false,
      ),
    );
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    expect(supervisor.activeCount()).toBe(0);
    expect((yield* bridge.takeCellImages("r", "t", "interrupt")).journal).toHaveLength(0);
  }),
);
