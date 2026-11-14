import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as HostProcess from "@goat/shared/HostProcess";
import { SpawnExecutableResolution } from "@goat/shared/shell";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

const OPENCODE_SERVER_IDLE_TTL = "30 seconds";
const MAX_OWNED_SERVERS = 32;

export interface OpenCodeServerLaunch {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv | undefined;
}

interface ServerEntry {
  readonly launch: OpenCodeServerLaunch;
  readonly server: OpenCodeRuntime.OpenCodeServerProcess;
  readonly scope: Scope.Closeable;
  borrowers: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
}

export const sameOpenCodeServerLaunch = (
  left: OpenCodeServerLaunch,
  right: OpenCodeServerLaunch,
) => {
  if (left.binaryPath !== right.binaryPath) return false;
  if (left.environment === undefined || right.environment === undefined)
    return left.environment === right.environment;
  const keys = Object.keys(left.environment);
  return (
    keys.length === Object.keys(right.environment).length &&
    keys.every((key) => left.environment?.[key] === right.environment?.[key])
  );
};

export class OpenCodeServerOwner extends Context.Service<
  OpenCodeServerOwner,
  {
    readonly captureLaunch: Effect.Effect<OpenCodeServerLaunch>;
    readonly withServer: <A, E, R>(
      use: (server: OpenCodeRuntime.OpenCodeServerProcess) => Effect.Effect<A, E, R>,
      launch?: OpenCodeServerLaunch,
    ) => Effect.Effect<A, E | OpenCodeRuntime.OpenCodeRuntimeError, R>;
  }
>()("@goat/provider-opencode/server/OpenCodeServerOwner") {}

export const make = Effect.fn("OpenCodeServerOwner.make")(function* (input: {
  readonly binaryPath: string;
  readonly directory: string;
  readonly serverPassword?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly currentEnvironment?: Effect.Effect<NodeJS.ProcessEnv>;
  readonly verify?: (url: string) => Effect.Effect<string, OpenCodeRuntime.OpenCodeRuntimeError>;
  readonly onClosed?: (url: string) => void;
}) {
  const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const platform = yield* HostProcess.Platform;
  const resolveExecutable = yield* SpawnExecutableResolution;
  const ownerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const mutex = yield* Semaphore.make(1);
  const entries: ServerEntry[] = [];
  let closed = false;
  const captureLaunch = Effect.gen(function* () {
    const current = input.currentEnvironment ? yield* input.currentEnvironment : input.environment;
    const environment = current === undefined ? undefined : { ...current };
    return {
      environment,
      binaryPath:
        environment === undefined
          ? input.binaryPath
          : (resolveExecutable(input.binaryPath, platform, environment) ?? input.binaryPath),
    };
  });
  const cancelIdleClose = Effect.fn("OpenCodeServerOwner.cancelIdleClose")(function* (
    entry: ServerEntry,
  ) {
    const fiber = entry.idleCloseFiber;
    entry.idleCloseFiber = null;
    if (fiber !== null) yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
  });
  const closeServer = Effect.fn("OpenCodeServerOwner.closeServer")(function* (entry: ServerEntry) {
    const index = entries.indexOf(entry);
    if (index < 0) return;
    entries.splice(index, 1);
    input.onClosed?.(entry.server.url);
    yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
  });
  const watchServerExit = Effect.fn("OpenCodeServerOwner.watchServerExit")(function* (
    entry: ServerEntry,
  ) {
    yield* entry.server.exitCode;
    yield* mutex.withPermit(
      Effect.gen(function* () {
        if (!entries.includes(entry)) return;
        yield* cancelIdleClose(entry);
        yield* closeServer(entry);
      }),
    );
  });
  const acquireServer = (launch: OpenCodeServerLaunch) =>
    mutex.withPermit(
      Effect.gen(function* () {
        const existing = entries.find((entry) => sameOpenCodeServerLaunch(entry.launch, launch));
        if (existing !== undefined) {
          if (yield* existing.server.isRunning) {
            if (closed && existing.borrowers === 0)
              return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail:
                  "The OpenCode provider was reconfigured; its server restarts with the new settings.",
              });
            yield* cancelIdleClose(existing);
            existing.borrowers++;
            return existing;
          }
          yield* cancelIdleClose(existing);
          yield* closeServer(existing);
        }
        if (closed)
          return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "startOpenCodeServerProcess",
            detail:
              "The OpenCode provider was reconfigured; its server restarts with the new settings.",
          });
        if (entries.length >= MAX_OWNED_SERVERS) {
          const idle = entries.find((entry) => entry.borrowers === 0);
          if (idle === undefined)
            return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
              operation: "startOpenCodeServerProcess",
              detail: "Too many OpenCode servers are in use by this provider.",
            });
          yield* cancelIdleClose(idle);
          yield* closeServer(idle);
        }
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const scope = yield* Scope.make();
            const started = yield* Effect.exit(
              restore(
                runtime
                  .startOpenCodeServerProcess({
                    binaryPath: launch.binaryPath,
                    directory: input.directory,
                    ...(input.serverPassword !== undefined
                      ? { serverPassword: input.serverPassword }
                      : {}),
                    ...(launch.environment !== undefined
                      ? { environment: launch.environment }
                      : {}),
                    ...(input.verify ? { verify: input.verify } : {}),
                  })
                  .pipe(Effect.provideService(Scope.Scope, scope)),
              ),
            );
            if (Exit.isFailure(started)) {
              yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
              return yield* Effect.failCause(started.cause);
            }
            const entry: ServerEntry = {
              launch,
              server: started.value,
              scope,
              borrowers: 1,
              idleCloseFiber: null,
            };
            entries.push(entry);
            yield* watchServerExit(entry).pipe(Effect.forkIn(ownerScope));
            return entry;
          }),
        );
      }),
    );
  const releaseServer = (entry: ServerEntry) =>
    mutex.withPermit(
      Effect.gen(function* () {
        if (!entries.includes(entry)) return;
        entry.borrowers = Math.max(0, entry.borrowers - 1);
        if (entry.borrowers > 0) return;
        if (closed) {
          yield* closeServer(entry);
          return;
        }
        yield* cancelIdleClose(entry);
        entry.idleCloseFiber = yield* Effect.sleep(OPENCODE_SERVER_IDLE_TTL).pipe(
          Effect.andThen(
            mutex.withPermit(
              Effect.gen(function* () {
                if (!entries.includes(entry) || entry.borrowers > 0) return;
                entry.idleCloseFiber = null;
                yield* closeServer(entry);
              }),
            ),
          ),
          Effect.forkIn(ownerScope),
        );
      }),
    );
  yield* Effect.addFinalizer(() =>
    mutex.withPermit(
      Effect.gen(function* () {
        closed = true;
        for (const entry of entries.toReversed()) {
          yield* cancelIdleClose(entry);
          if (entry.borrowers === 0) yield* closeServer(entry);
        }
      }),
    ),
  );
  return OpenCodeServerOwner.of({
    captureLaunch,
    withServer: Effect.fn("OpenCodeServerOwner.withServer")(function (use, launch) {
      return Effect.uninterruptibleMask((restore) =>
        restore(launch === undefined ? captureLaunch : Effect.succeed(launch)).pipe(
          Effect.flatMap((selected) => restore(acquireServer(selected))),
          Effect.flatMap((entry) =>
            restore(use(entry.server)).pipe(Effect.ensuring(releaseServer(entry))),
          ),
        ),
      );
    }),
  });
});

/** @public */
export const layer = (input: {
  readonly binaryPath: string;
  readonly directory: string;
  readonly serverPassword?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly verify?: (url: string) => Effect.Effect<string, OpenCodeRuntime.OpenCodeRuntimeError>;
}) => Layer.effect(OpenCodeServerOwner, make(input));
