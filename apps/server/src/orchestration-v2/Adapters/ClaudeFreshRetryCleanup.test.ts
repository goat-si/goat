import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeEvents from "node:events";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- fake SDK child process uses Node streams.
import * as NodeStream from "node:stream";
import { NodeServices, NodeCrypto } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@goat/contracts";
import { ProviderEventLoggers } from "@goat/provider-core/server/ProviderEventLoggers";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as Descendants from "./ClaudeDescendants.ts";
import * as Spawn from "./ClaudeProcessSpawn.ts";
import { isClaudeMcpRegistrationTimeoutError } from "./ClaudeQueryRunnerErrors.ts";
import { ClaudeAgentSdkQueryRunner, layerQueryRunner } from "./ClaudeAgentSdkQueryRunner.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });
vi.mock("./ClaudeDescendants.ts", { spy: true });
vi.mock("./ClaudeProcessSpawn.ts", { spy: true });

it.effect.each([true, false])(
  "fresh retry waits for owned descendant cleanup (released=%s)",
  (release) =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const stopping = yield* Deferred.make<void>();
        const started = Promise.withResolvers<void>();
        const events = new NodeEvents.EventEmitter();
        const stdin = new NodeStream.PassThrough();
        const stdout = new NodeStream.PassThrough();
        const kill = vi.fn(() => {
          events.emit("exit", null, "SIGKILL");
          return true;
        });
        const child = {
          pid: 999999,
          stdin,
          stdout,
          killed: false,
          exitCode: null,
          signalCode: null,
          kill,
          on: events.on.bind(events),
          once: events.once.bind(events),
          off: events.off.bind(events),
        };
        let tracks = 0;
        const sampler = vi.spyOn(Descendants, "makeClaudeDescendantSampler").mockReturnValue(
          Effect.succeed({
            track: () => (
              tracks++,
              {
                refresh: Effect.void,
                work: () => {},
                settle: Effect.void,
                follow: () => Effect.void,
                stop: Deferred.succeed(stopping, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                ),
              }
            ),
          }),
        );
        const spawn = vi.spyOn(Spawn, "spawnClaudeProcessGroup").mockReturnValue(child as never);
        const requests: Array<unknown> = [];
        const registrations: Array<unknown> = [];
        const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
          const first = requests.length === 0;
          requests.push(options);
          if (first)
            options?.spawnClaudeCodeProcess?.({
              command: "claude",
              args: [],
              env: {},
              signal: new AbortController().signal,
            });
          return {
            initializationResult: async () => ({}),
            setMcpServers: (servers: unknown) => {
              if (first) {
                started.resolve();
                return new Promise(() => {});
              }
              registrations.push(servers);
              return Promise.resolve({ added: ["cua-driver"], removed: [], errors: {} });
            },
            close: () => {},
            [Symbol.asyncDispose]: async () => {},
          } as unknown as ClaudeSdk.Query;
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            sampler.mockRestore();
            spawn.mockRestore();
            query.mockRestore();
            stdin.destroy();
            stdout.destroy();
          }),
        );
        yield* Effect.gen(function* () {
          const runner = yield* ClaudeAgentSdkQueryRunner;
          const opening = yield* runner
            .open({
              threadId: ThreadId.make("cleanup"),
              providerSessionId: ProviderSessionId.make("cleanup"),
              options: {
                sessionId: "initial",
                model: "claude",
                tools: [],
                permissionMode: "default",
                mcpServers: { "cua-driver": { type: "http", url: "http://localhost:1/mcp" } },
              },
            })
            .pipe(Effect.result, Effect.forkChild);
          const began = yield* Effect.raceFirst(
            Effect.promise(() => started.promise).pipe(Effect.as(true)),
            Fiber.await(opening).pipe(Effect.as(false)),
          );
          if (!began) {
            assert.equal((yield* Fiber.join(opening))._tag, "Success");
            return;
          }
          yield* TestClock.adjust("90 seconds");
          const didStop = yield* Effect.raceFirst(
            Deferred.await(stopping).pipe(Effect.as(true)),
            Fiber.await(opening).pipe(Effect.as(false)),
          );
          if (!didStop) {
            const result = yield* Fiber.join(opening);
            assert.fail(
              `cleanup did not start: result=${result._tag}, queries=${requests.length}, spawns=${spawn.mock.calls.length}, samplers=${sampler.mock.calls.length}, kills=${kill.mock.calls.length}, listeners=${events.listenerCount("exit")}, tracks=${tracks}, child=${spawn.mock.results[0]?.value === child}, ret=${typeof spawn.mock.results[0]?.value}`,
            );
          }
          assert.equal(requests.length, 1);
          if (release) yield* Deferred.succeed(gate, undefined);
          else yield* TestClock.adjust("5 seconds");
          const result = yield* Fiber.join(opening);
          assert.equal(result._tag, release ? "Success" : "Failure");
          assert.equal(requests.length, release ? 2 : 1);
          if (result._tag === "Success") {
            assert.property(registrations[0], "cua-driver");
            yield* result.success.close;
          } else {
            assert.isTrue(isClaudeMcpRegistrationTimeoutError(result.failure.cause));
          }
        }).pipe(
          Effect.provide(
            layerQueryRunner.pipe(
              Layer.provide(
                Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined }),
              ),
              Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
        );
      }),
    ),
);
