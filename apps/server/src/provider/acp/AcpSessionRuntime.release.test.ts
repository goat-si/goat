import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";

const mockAgentPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);

describe("AcpSessionRuntime release", () => {
  it.effect("keeps the owner release pending until a termination-started cleanup finishes", () =>
    Effect.gen(function* () {
      const cleanupStarted = yield* Deferred.make<void>();
      const ownerReleaseStarted = yield* Deferred.make<void>();
      const cleanupFinished = yield* Deferred.make<void>();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const owner = yield* Scope.make();
      const runtime = yield* AcpSessionRuntime.make({
        spawn: { command: "node", args: [mockAgentPath] },
        cwd: process.cwd(),
        clientInfo: { name: "goat-test", version: "0.0.0" },
        authMethodId: "test",
      }).pipe(
        Effect.provideService(Scope.Scope, owner),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            spawner.spawn(command).pipe(
              // Models a process release still waiting for the agent to exit.
              Effect.tap(() =>
                Effect.addFinalizer(() =>
                  Deferred.succeed(cleanupStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(ownerReleaseStarted)),
                    Effect.andThen(Deferred.succeed(cleanupFinished, undefined)),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      // Added after the runtime, so it is the first owner finalizer to run.
      yield* Scope.addFinalizer(owner, Deferred.succeed(ownerReleaseStarted, undefined));
      yield* runtime.start();
      yield* runtime.notify("_test/exit", {});
      yield* Deferred.await(cleanupStarted);

      yield* Scope.close(owner, Exit.void);

      expect(yield* Deferred.isDone(cleanupFinished)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
