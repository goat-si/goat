// @effect-diagnostics nodeBuiltinImport:off - Real child fixtures stage a local asset under a temporary directory.
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
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

vi.mock("node:child_process", { spy: true });

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
      yield* Effect.addFinalizer(() => Effect.sync(supervisor.dispose));
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

it.live("a later turn of the thread keeps its top-level declarations until a reset", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const asset = yield* resolveScreenRuntimeAsset("dev");
      const limits = screenRunLimits({ cellWallMs: 5000 });
      const supervisor = fixtureSupervisor({ asset, limits, hostBridge: new ScreenHostBridge() });
      yield* Effect.addFinalizer(() => Effect.sync(supervisor.dispose));
      const turn = (runId: string, cellId: string) => ({
        runId,
        turnId: runId,
        context: { ...context(cellId, limits), runId, turnId: runId },
      });
      yield* supervisor.runCell(
        turn("r1", "one"),
        "const greeting = 'hi'; let { n } = { n: 2 }; function twice(x) { return x * n; } if (true) { const hidden = 1; } return 1;",
        false,
      );
      yield* supervisor.finishTurn("r1", "r1", "turnEnded");
      const later = yield* supervisor.runCell(
        turn("r2", "two"),
        "return [greeting, twice(3), typeof hidden];",
        false,
      );
      expect(later.value).toEqual(["hi", 6, "undefined"]);
      expect(supervisor.consumeLost("thread")).toBe(false);
      const reset = yield* supervisor.runCell(turn("r2", "three"), "return typeof greeting;", true);
      expect(reset.value).toBe("undefined");
    }),
  ),
);

it.live(
  "a later cell shares live bindings with the earlier cell's closures, runs no stray getter, and keeps strict mode as written",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const asset = yield* resolveScreenRuntimeAsset("dev");
        const limits = screenRunLimits({ cellWallMs: 5000 });
        const supervisor = fixtureSupervisor({ asset, limits, hostBridge: new ScreenHostBridge() });
        yield* Effect.addFinalizer(() => Effect.sync(supervisor.dispose));
        const cell = (cellId: string, source: string) =>
          supervisor
            .runCell({ runId: "r", turnId: "t", context: context(cellId, limits) }, source, false)
            .pipe(Effect.map((result) => result.value));
        yield* cell("define", "let n = 0; function inc() { return ++n; } return n;");
        expect(yield* cell("mutate", "inc(); inc(); return n;")).toBe(2);
        expect(yield* cell("assign", "n = 10; return inc();")).toBe(11);
        yield* cell(
          "getter",
          "Object.defineProperty(globalThis, 'label', { get() { globalThis.reads = (globalThis.reads ?? 0) + 1; return 1; }, configurable: true }); return 0;",
        );
        expect(
          yield* cell(
            "pattern",
            "const { label: value } = { label: 5 }; return [value, globalThis.reads ?? 0];",
          ),
        ).toEqual([5, 0]);
        expect(
          yield* cell(
            "strict",
            "/* first */ 'use strict'; return (function () { return this === undefined; })();",
          ),
        ).toBe(true);
        // The body stays a function body: its function declarations mean what they would unwrapped.
        expect(yield* cell("redeclare", "function f() {} var f; return typeof f;")).toBe(
          "function",
        );
        expect(
          yield* cell(
            "annex-b",
            "function g() { return 1; } { function g() { return 2; } } return g();",
          ),
        ).toBe(2);
        // Names the saver uses cannot collide with the cell's own.
        expect(
          yield* cell(
            "helper-names",
            "let __screenExport = 1; let __screenKeep = () => { throw 1; }; const kept = 3; return __screenExport + kept;",
          ),
        ).toBe(4);
        expect(yield* cell("kept-after-shadow", "return kept;")).toBe(3);
        // QuickJS reads the directives: an escaped CRLF in an earlier one still leaves the cell strict.
        expect(
          yield* cell(
            "crlf",
            '"a\\\r\n"; "use strict"; return (function () { return this === undefined; })();',
          ),
        ).toBe(true);
        expect(yield* cell("sloppy", "'use strict' + ''; loose = 1; return loose;")).toBe(1);
        // A write to a kept name reaches the binding its closures read, whatever the name is.
        yield* cell("define-v", "let v = 1; function readV() { return v; } return v;");
        expect(yield* cell("write-v", "v = 9; return [v, readV()];")).toEqual([9, 9]);
        // A let the scanner might take for a const stays writable; QuickJS judges constness.
        yield* cell(
          "misread",
          "let m = 1; let y = 2; y++ / (function () {\n  const m = 2; return m;\n})(); return m;",
        );
        expect(yield* cell("write-m", "m = 9; return m;")).toBe(9);
        // Saving runs nothing the cell replaced, such as a hooked Object.defineProperty.
        const hooked = yield* supervisor.runCell(
          { runId: "r", turnId: "t", context: context("hooked", limits) },
          "const original = Object.defineProperty; Object.defineProperty = (...args) => { console.log('define'); return original(...args); }; const afterHook = 1; return afterHook;",
          false,
        );
        expect(hooked.console).toEqual([]);
        expect(yield* cell("after-hook", "return afterHook;")).toBe(1);
        // A getter on the returned value or error runs before the cell's bindings are published.
        expect(
          yield* cell(
            "getter-result",
            "const result = 7; return { get value() { return globalThis.result ?? 'absent'; } };",
          ),
        ).toEqual({ value: "absent" });
        const thrown = yield* supervisor.runCell(
          { runId: "r", turnId: "t", context: context("getter-error", limits) },
          "const reason = 'kept'; const error = new Error(); Object.defineProperty(error, 'message', { get() { return globalThis.reason ?? 'absent'; } }); throw error;",
          false,
        );
        expect(thrown.error).toMatchObject({ message: "absent" });
        expect(yield* cell("after-getters", "return [result, reason];")).toEqual([7, "kept"]);
        // Saving restores a global a nested var named, without reading Object.prototype.
        const inherited = yield* supervisor.runCell(
          { runId: "r", turnId: "t", context: context("inherited-get", limits) },
          "globalThis.victim = 1; Reflect.defineProperty(Object.prototype, 'get', { get() { console.log('inherited'); return undefined; }, configurable: true }); function g() { var victim = 2; } return 0;",
          false,
        );
        expect(inherited.console).toEqual([]);
        expect(yield* cell("victim", "delete Object.prototype.get; return victim;")).toBe(1);
        // Saving uses the real global object, never one a cell put in globalThis.
        const proxied = yield* supervisor.runCell(
          { runId: "r", turnId: "t", context: context("proxied", limits) },
          "const real = globalThis; const log = (k) => console.log('trap ' + String(k)); globalThis = new Proxy(real, { get(t, k) { log(k); return Reflect.get(t, k); }, has(t, k) { log(k); return Reflect.has(t, k); }, defineProperty(t, k, d) { log(k); return Reflect.defineProperty(t, k, d); }, getOwnPropertyDescriptor(t, k) { log(k); return Reflect.getOwnPropertyDescriptor(t, k); }, deleteProperty(t, k) { log(k); return Reflect.deleteProperty(t, k); } }); const x = 1; return x;",
          false,
        );
        expect(proxied.console).toEqual([]);
        // A var inside a nested function is not the cell's binding, even when it names an inherited one.
        yield* cell("nested", "function f() { var toString = 1; } return 0;");
        expect(yield* cell("inherited", "return typeof toString;")).toBe("function");
        // QuickJS decides which strings are directives, and the cell runs as it would unwrapped:
        // it counts one ended by a semicolon, and not one followed by a block on the next line.
        const strictBlock = yield* supervisor.runCell(
          { runId: "r", turnId: "t", context: context("strict-block", limits) },
          '"use strict";\n{ undeclared = 9; }\nreturn 1;',
          false,
        );
        expect(strictBlock.status).toBe("failed");
        expect(
          yield* cell("quickjs-sloppy", '"use strict"\n{ undeclaredToo = 9; }\nreturn 1;'),
        ).toBe(1);
        // A line opening with != still compares with the directive, so the cell stays sloppy.
        expect(yield* cell("compare", '"use strict"\n!= ""; looser = 1; return looser;')).toBe(1);
        yield* cell("constant", "const fixed = 1; return fixed;");
        expect(
          yield* cell(
            "reassign",
            "try { fixed = 2; return 'assigned'; } catch (error) { return error instanceof TypeError; }",
          ),
        ).toBe(true);
      }),
    ),
);

it.live("a cell cut off by its deadline keeps nothing, and a reset after it still runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const asset = yield* resolveScreenRuntimeAsset("dev");
      const limits = screenRunLimits({ cellWallMs: 300 });
      const supervisor = fixtureSupervisor({
        asset,
        limits,
        hostBridge: new ScreenHostBridge(),
        scheduleDeadline: childDeadlineOnly,
      });
      yield* Effect.addFinalizer(() => Effect.sync(supervisor.dispose));
      const run = (cellId: string, source: string, reset = false) =>
        supervisor.runCell(
          { runId: "r", turnId: "t", context: context(cellId, limits) },
          source,
          reset,
        );
      expect((yield* run("hang", "let saved = 7; await new Promise(() => {});")).status).toBe(
        "deadline",
      );
      expect((yield* run("after", "return typeof saved;")).value).toBe("undefined");
      expect((yield* run("reset", "return 42;", true)).value).toBe(42);
    }),
  ),
);

it.live("a disposed supervisor boots no further spare", () =>
  Effect.gen(function* () {
    const asset = yield* resolveScreenRuntimeAsset("dev");
    const limits = screenRunLimits({ cellWallMs: 5000 });
    const supervisor = fixtureSupervisor({ asset, limits, hostBridge: new ScreenHostBridge() });
    const spawns = () =>
      vi
        .mocked(NodeChildProcess.spawn)
        .mock.calls.filter((call) => call[1]?.includes("__screen-run-child")).length;
    supervisor.dispose();
    const before = spawns();
    supervisor.prewarm();
    expect(spawns()).toBe(before);
  }),
);

it.live("a new thread's first cell takes the booted spare instead of starting a child", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const asset = yield* resolveScreenRuntimeAsset("dev");
      const limits = screenRunLimits({ cellWallMs: 5000 });
      const supervisor = fixtureSupervisor({ asset, limits, hostBridge: new ScreenHostBridge() });
      yield* Effect.addFinalizer(() => Effect.sync(supervisor.dispose));
      const spawns = () =>
        vi
          .mocked(NodeChildProcess.spawn)
          .mock.calls.filter((call) => call[1]?.includes("__screen-run-child")).length;
      const before = spawns();
      yield* supervisor.runCell(
        { runId: "r", turnId: "t", context: context("one", limits) },
        "return 1;",
        false,
      );
      // The thread's own child, then the spare booted while its cell ran.
      expect(spawns() - before).toBe(2);
      const other = yield* supervisor.runCell(
        { runId: "r", turnId: "t", context: { ...context("two", limits), threadId: "other" } },
        "return 2;",
        false,
      );
      expect(other.value).toBe(2);
      // Only the replacement spare: the other thread took the booted one.
      expect(spawns() - before).toBe(3);
      expect(supervisor.activeCount()).toBe(2);
    }),
  ),
);

it.live("screen state keeps a tab handle across cells and reset clears it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const asset = yield* resolveScreenRuntimeAsset("dev");
      const limits = screenRunLimits({ cellWallMs: 5000 });
      const bridge = new ScreenHostBridge();
      const ref = {
        id: "tab",
        kind: "tab" as const,
        environmentId: "env",
        runId: "r",
        turnId: "t",
        generation: 0,
      };
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: (call) =>
          Effect.succeed({
            value:
              call.method === "select_tab"
                ? { targetRef: ref }
                : call.method === "tab_status"
                  ? { title: "Workspace" }
                  : [{ tabId: "tab" }],
            category: "confirmed",
            evidence: ["Current tab observed"],
          }),
      });
      const supervisor = fixtureSupervisor({ asset, limits, hostBridge: bridge });
      yield* Effect.addFinalizer(() => Effect.sync(supervisor.dispose));
      const authorized = (cellId: string) => ({
        ...context(cellId, limits),
        invocation: {
          ...context(cellId, limits).invocation,
          capabilities: new Set(["preview"] as const),
          reauthorize: () => Effect.void,
        },
      });
      const first = yield* supervisor.runCell(
        { runId: "r", turnId: "t", context: authorized("one") },
        "screen.state.tab = await screen.tab({tabId: 'tab'}); return typeof screen.state.tab.status;",
        false,
      );
      expect(first).toMatchObject({ status: "completed", value: "function" });
      const second = yield* supervisor.runCell(
        { runId: "r", turnId: "t", context: authorized("two") },
        "return [await screen.state.tab.status(), await screen.listTabs(), await screen.list_tabs()];",
        false,
      );
      expect(second).toMatchObject({
        status: "completed",
        value: [{ title: "Workspace" }, [{ tabId: "tab" }], [{ tabId: "tab" }]],
      });
      const reset = yield* supervisor.runCell(
        { runId: "r", turnId: "t", context: authorized("three") },
        "return Object.hasOwn(screen.state, 'tab');",
        true,
      );
      expect(reset).toMatchObject({ status: "completed", value: false });
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
    yield* Effect.sync(supervisor.dispose);
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
    yield* Effect.sync(supervisor.dispose);
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
    yield* Effect.sync(supervisor.dispose);
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
    yield* Effect.sync(supervisor.dispose);
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
    yield* Effect.sync(supervisor.dispose);
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
    }).pipe(Effect.ensuring(Effect.sync(supervisor.dispose)));
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
      // A started child, so its start does not use up the cell's wall time.
      yield* supervisor.runCell(
        { runId: "r", turnId: "t", context: context("warmup", limits) },
        "return true;",
        false,
      );
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
    }).pipe(Effect.ensuring(Effect.sync(supervisor.dispose)));
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
      // The turn's cell already returned, so its end leaves the thread's child for the next turn.
      expect(supervisor.activeCount()).toBe(1);
      supervisor.dispose();
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
    yield* Effect.sync(supervisor.dispose);
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
    yield* Effect.sync(supervisor.dispose);
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
      yield* Effect.addFinalizer(() => Effect.sync(supervisor.dispose));
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
      yield* Effect.addFinalizer(() => Effect.sync(supervisor.dispose));
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
      }).pipe(Effect.ensuring(Effect.sync(supervisor.dispose)));
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }
  }),
);

it.live("Stop kills only the cut thread's child", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const asset = yield* resolveScreenRuntimeAsset("dev");
      // The default wall limit lies far beyond the Stop, so only the Stop ends the spinning cell
      // while the other thread's child boots.
      const limits = screenRunLimits();
      const supervisor = fixtureSupervisor({ asset, limits, hostBridge: new ScreenHostBridge() });
      yield* Effect.addFinalizer(() => Effect.sync(supervisor.dispose));
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
          context: { ...context("two", limits), runId: "r2", turnId: "t2", threadId: "other" },
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
          context: { ...context("two", limits), runId: "r2", turnId: "t2", threadId: "other" },
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
    yield* Effect.sync(supervisor.dispose);
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

it.live.each([false, true])(
  "rejects an oversized screen frame before newline or child EOF, keeping what ended it for the row (effect dispatched: %s)",
  (effectDispatched) =>
    Effect.gen(function* () {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          "-e",
          `
      require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
        const frame = JSON.parse(line);
        if (frame.t === 'boot') process.stdout.write(JSON.stringify({t:'ready'}) + '\\n');
        if (frame.t === 'cell' && ${effectDispatched}) process.stdout.write(JSON.stringify({
          t: 'call', runId: 'r', turnId: 't', cellId: frame.cellId, callId: 1, method: 'list_apps', args: {}, deadlineMillis: frame.deadlineMillis
        }) + '\\n');
        else if (frame.t === 'cell' || frame.t === 'reply') process.stdout.write(Buffer.alloc(256 * 1024 + 1, 32));
      });
    `,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      using _spawn = vi.spyOn(NodeChildProcess, "spawn").mockReturnValueOnce(child);
      let bytes = 0;
      const written = new Promise<void>((resolve) =>
        child.stdout.on("data", (chunk: Buffer) => {
          const newline = chunk.lastIndexOf(10);
          bytes = newline < 0 ? bytes + chunk.byteLength : chunk.byteLength - newline - 1;
          if (bytes > 256 * 1024) queueMicrotask(resolve);
        }),
      );
      const limits = screenRunLimits({ cellWallMs: 5000 });
      const bridge = new ScreenHostBridge();
      let dispatched = 0;
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: () =>
          Effect.sync(() => {
            dispatched++;
            return { value: true, category: "confirmed" as const };
          }),
      });
      const supervisor = fixtureSupervisor({
        asset: { path: "unused", sha256: "unused" },
        limits,
        hostBridge: bridge,
        scheduleDeadline: childDeadlineOnly,
      });
      yield* Effect.gen(function* () {
        const running = yield* supervisor
          .runCell(
            { runId: "r", turnId: "t", context: context("oversized", limits) },
            "return true;",
            false,
          )
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() => written);
        const closedBeforeEof = supervisor.activeCount() === 0;
        if (!closedBeforeEof) yield* supervisor.cutCell("r", "t", "oversized", "test cleanup");
        const result = yield* Fiber.join(running);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.code).toBe(effectDispatched ? "unknown_outcome" : "output_limit");
          expect(result.failure.effectStarted).toBe(effectDispatched);
          expect(result.failure.receipts).toHaveLength(effectDispatched ? 1 : 0);
          // The agent hears unknown_outcome; the cell's timeline row still knows the frame ended it.
          expect(result.failure.endedBy).toBe("output_limit");
          expect(result.failure.journal).toEqual(result.failure.receipts);
        }
        expect(closedBeforeEof).toBe(true);
        expect(dispatched).toBe(effectDispatched ? 1 : 0);
      }).pipe(Effect.ensuring(Effect.sync(supervisor.dispose)));
    }),
);
