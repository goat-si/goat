// @effect-diagnostics nodeBuiltinImport:off - Real child fixtures stage a local asset under a temporary directory.
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as NodeFsp from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";
import { createRequire } from "node:module";
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
}) =>
  createScreenRunSupervisor({
    asset: input.asset,
    limits: input.limits,
    hostBridge: input.hostBridge,
    invocation: {
      command: input.command ?? process.execPath,
      entrypoint: NodeUrl.fileURLToPath(new URL("../bin.ts", import.meta.url)),
    },
    runCallback: (effect, signal) => Effect.runPromise(effect, signal ? { signal } : undefined),
  });

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
  Effect.gen(function* () {
    const asset = yield* resolveScreenRuntimeAsset("dev");
    const limits = screenRunLimits({ cellWallMs: 5000 });
    const bridge = new ScreenHostBridge();
    const supervisor = fixtureSupervisor({ asset, limits, hostBridge: bridge });
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
    yield* supervisor.finishTurn("r", "t", "test");
    expect(supervisor.activeCount()).toBe(0);
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

it.live("busy loop reaches the child deadline without preserving its turn", () =>
  Effect.gen(function* () {
    const asset = yield* resolveScreenRuntimeAsset("dev");
    const limits = screenRunLimits({ cellWallMs: 1000 });
    const supervisor = fixtureSupervisor({ asset, limits, hostBridge: new ScreenHostBridge() });
    const outcome = yield* supervisor
      .runCell(
        { runId: "r", turnId: "t", context: context("one", limits) },
        "while (true) {}",
        false,
      )
      .pipe(Effect.result);
    expect(outcome._tag === "Failure" || outcome.success.status === "deadline").toBe(true);
    yield* supervisor.finishTurn("r", "t", "test");
    expect(supervisor.activeCount()).toBe(0);
  }),
);

it.live("large allocations stop within the fixed WASM memory cap", () =>
  Effect.gen(function* () {
    const asset = yield* resolveScreenRuntimeAsset("dev");
    const limits = screenRunLimits({ cellWallMs: 5000 });
    const supervisor = fixtureSupervisor({ asset, limits, hostBridge: new ScreenHostBridge() });
    const result = yield* supervisor
      .runCell(
        { runId: "r", turnId: "t", context: context("one", limits) },
        "const parts = []; for (let i = 0; i < 40; i++) parts.push('x'.repeat(4 * 1024 * 1024) + i); return parts.length;",
        false,
      )
      .pipe(Effect.result);
    expect(result._tag === "Failure" || result.success.status !== "completed").toBe(true);
    yield* supervisor.finishTurn("r", "t", "test");
  }),
);

it.live("an Electron-as-Node child loads the staged WASM", () =>
  Effect.promise(async () => {
    const asset = await Effect.runPromise(resolveScreenRuntimeAsset("dev"));
    const directory = await NodeFsp.mkdtemp(
      NodePath.join(NodeOs.tmpdir(), "goat-screen-electron-"),
    );
    const staged = NodePath.join(directory, "screen-code/quickjs.wasm");
    const desktopRequire = createRequire(new URL("../../../desktop/package.json", import.meta.url));
    const electron = desktopRequire("electron") as string;
    try {
      await NodeFsp.mkdir(NodePath.dirname(staged), { recursive: true });
      await NodeFsp.copyFile(asset.path, staged);
      const limits = screenRunLimits({ cellWallMs: 5000 });
      const supervisor = fixtureSupervisor({
        asset: { path: staged, sha256: asset.sha256 },
        limits,
        hostBridge: new ScreenHostBridge(),
        command: electron,
      });
      const result = await Effect.runPromise(
        supervisor.runCell(
          { runId: "r", turnId: "t", context: context("one", limits) },
          "return 7;",
          false,
        ),
      );
      expect(result.value).toBe(7);
      await Effect.runPromise(supervisor.finishTurn("r", "t", "test"));
    } finally {
      await NodeFsp.rm(directory, { recursive: true, force: true });
    }
  }),
);

it.live("Stop kills only the child owned by the cut turn", () =>
  Effect.promise(async () => {
    const asset = await Effect.runPromise(resolveScreenRuntimeAsset("dev"));
    const limits = screenRunLimits({ cellWallMs: 5000 });
    const supervisor = fixtureSupervisor({ asset, limits, hostBridge: new ScreenHostBridge() });
    const spinning = Effect.runPromise(
      supervisor.runCell(
        {
          runId: "r1",
          turnId: "t1",
          context: { ...context("one", limits), runId: "r1", turnId: "t1" },
        },
        "while (true) {}",
        false,
      ),
    ).then(
      () => "completed",
      () => "cut",
    );
    expect(supervisor.activeCount()).toBe(1);
    await Effect.runPromise(supervisor.cutCell("r1", "t1", "one", "Stop"));
    expect(await spinning).toBe("cut");
    const surviving = await Effect.runPromise(
      supervisor.runCell(
        {
          runId: "r2",
          turnId: "t2",
          context: { ...context("two", limits), runId: "r2", turnId: "t2" },
        },
        "return 9;",
        false,
      ),
    );
    expect(surviving.value).toBe(9);
    await Effect.runPromise(supervisor.finishTurn("r2", "t2", "test"));
  }),
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
