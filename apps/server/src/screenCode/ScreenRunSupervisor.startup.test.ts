// @effect-diagnostics nodeBuiltinImport:off - The fixture controls a child process and its readiness.
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as NodeURL from "node:url";
import type { EnvironmentId, ThreadId, ProviderInstanceId } from "@goat/contracts";
import { screenRunLimits } from "./ScreenRunLimits.ts";
import { ScreenHostBridge } from "./ScreenHostBridge.ts";
import { createScreenRunSupervisor } from "./ScreenRunSupervisor.ts";

vi.mock("node:child_process", { spy: true });

const fixtureSupervisor = (input: {
  asset: { path: string; sha256: string };
  limits: ReturnType<typeof screenRunLimits>;
  hostBridge: ScreenHostBridge;
  command?: string;
  scheduleDeadline?: (run: () => void, ms: number) => () => void;
  scheduleStartup?: (run: () => void, ms: number) => () => void;
}) =>
  createScreenRunSupervisor({
    asset: input.asset,
    limits: input.limits,
    hostBridge: input.hostBridge,
    ...(input.scheduleDeadline ? { scheduleDeadline: input.scheduleDeadline } : {}),
    ...(input.scheduleStartup ? { scheduleStartup: input.scheduleStartup } : {}),
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

it.live("waits for a fresh runtime before starting the cell clock", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          "-e",
          `
        let ready = false, early;
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const frame = JSON.parse(line);
          if (frame.t === 'boot') process.stderr.write('booted');
          if (frame.t === 'cell') {
            if (!ready) { early = frame; return; }
            process.stdout.write(JSON.stringify({t:'result', cellId:frame.cellId, status:'completed', value:7, console:[], truncated:[]}) + '\\n');
          }
          if (frame.t === 'release') {
            ready = true;
            if (early) process.stdout.write(JSON.stringify({t:'result', cellId:early.cellId, status:'deadline', console:[], truncated:[]}) + '\\n');
            else process.stdout.write(JSON.stringify({t:'ready'}) + '\\n');
          }
        });
      `,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const booted = new Promise<void>((resolve) => child.stderr.once("data", () => resolve()));
      using _spawn = vi.spyOn(NodeChildProcess, "spawn").mockReturnValueOnce(child);
      const limits = screenRunLimits({ cellWallMs: 1000 });
      const supervisor = fixtureSupervisor({
        asset: { path: "unused", sha256: "unused" },
        limits,
        hostBridge: new ScreenHostBridge(),
        scheduleDeadline: childDeadlineOnly,
      });
      yield* Effect.addFinalizer(() => Effect.sync(supervisor.dispose));
      const running = yield* supervisor
        .runCell({ runId: "r", turnId: "t", context: context("one", limits) }, "return 7;", false)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => booted);
      child.stdin.write('{"t":"release"}\n');
      const result = yield* Fiber.join(running);
      expect(result.status).toBe("completed");
      expect(result.value).toBe(7);
    }),
  ),
);

it.live("a runtime that never becomes ready fails without starting the cell", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const armed = Promise.withResolvers<() => void>();
      const limits = screenRunLimits({ cellWallMs: 1000 });
      const supervisor = fixtureSupervisor({
        asset: { path: "unused", sha256: "unused" },
        limits,
        hostBridge: new ScreenHostBridge(),
        scheduleStartup: (run) => {
          armed.resolve(run);
          return () => {};
        },
      });
      yield* Effect.addFinalizer(() => Effect.sync(supervisor.dispose));
      const running = yield* supervisor
        .runCell({ runId: "r", turnId: "t", context: context("one", limits) }, "return 7;", false)
        .pipe(Effect.result, Effect.forkChild);
      const expire = yield* Effect.promise(() => armed.promise);
      expire();
      const result = yield* Fiber.join(running);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.code).toBe("runtime_unavailable");
        expect(result.failure.startupFailed).toBe(true);
        expect(result.failure.effectStarted).toBe(false);
      }
    }),
  ),
);
