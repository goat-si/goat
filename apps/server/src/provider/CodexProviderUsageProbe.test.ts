import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import { checkCodexProviderStatus } from "./CodexProvider.ts";
import { mockHandle } from "./ProviderRegistry.testkit.ts";

const encoder = new TextEncoder();
const defaultCodexSettings = Schema.decodeSync(CodexSettings)({});

it.effect("shows Codex usage that answers after three seconds inside the probe budget", () =>
  Effect.gen(function* () {
    const usageRequested = yield* Deferred.make<void>();
    const answerUsage = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const output = yield* Queue.unbounded<Uint8Array>();
        const send = (message: unknown) =>
          Queue.offer(output, encoder.encode(`${JSON.stringify(message)}\n`));
        const results: Record<string, unknown> = {
          initialize: {
            userAgent: "codex_cli_rs/0.167.0",
            codexHome: "/nonexistent-codex-home",
            platformFamily: "unix",
            platformOs: "linux",
          },
          "account/read": {
            account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
            requiresOpenaiAuth: true,
          },
          "config/read": { config: {}, origins: {} },
          "skills/list": { data: [] },
          "model/list": { data: [] },
        };
        const answer = (line: string) => {
          const { id, method } = JSON.parse(line) as { id?: number; method?: string };
          if (id === undefined || method === undefined) return Effect.void;
          if (method !== "account/rateLimits/read") {
            return send({ id, result: results[method] ?? {} });
          }
          // The test answers once the clock has passed the old three-second cap.
          return Deferred.succeed(usageRequested, undefined).pipe(
            Effect.andThen(Deferred.await(answerUsage)),
            Effect.andThen(
              send({
                id,
                result: {
                  rateLimits: {
                    limitId: "codex",
                    planType: "pro",
                    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 2e9 },
                  },
                  rateLimitsByLimitId: null,
                  rateLimitResetCredits: null,
                  accountId: null,
                },
              }),
            ),
            Effect.forkIn(scope),
          );
        };
        const decoder = new TextDecoder();
        let buffered = "";
        return ChildProcessSpawner.makeHandle({
          ...mockHandle({ stdout: "", stderr: "", code: 0 }),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          stdin: Sink.forEach((chunk: Uint8Array) => {
            buffered += decoder.decode(chunk, { stream: true });
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";
            return Effect.forEach(lines.filter(Boolean), answer, { discard: true });
          }),
          stdout: Stream.fromQueue(output),
        });
      }),
    );
    const fiber = yield* checkCodexProviderStatus(defaultCodexSettings).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.forkChild,
    );
    yield* Deferred.await(usageRequested);
    yield* TestClock.adjust("4 seconds");
    yield* Deferred.succeed(answerUsage, undefined);
    const status = yield* Fiber.join(fiber);

    assert.strictEqual(status.auth.status, "authenticated");
    assert.isUndefined(status.usageLimits?.unavailable);
    assert.strictEqual(status.usageLimits?.windows[0]?.usedPercent, 42);
  }).pipe(Effect.provide(NodeServices.layer)),
);
