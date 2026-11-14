// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  GenerateMemorySummaryInput,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Hold from "../../../../apps/server/src/memory/MemoryGenerationHold.ts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";
import { MemoryGenerationRunnerError } from "@goat/provider-core/server/memoryGenerationRunner";
import { OpenCodeDriver } from "./driver.ts";

const isMemoryGenerationRunnerError = Schema.is(MemoryGenerationRunnerError);

it.effect("holds a missing executable until a due probe gets a non-repeatable version error", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const host = yield* ProviderHost.ProviderHost;
    const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
    let available = false;
    let commandCalls = 0;
    const instance = yield* OpenCodeDriver.create({
      instanceId: ProviderInstanceId.make("opencode-test"),
      displayName: undefined,
      environment: [],
      enabled: true,
      config: {
        ...OpenCodeDriver.defaultConfig(),
        binaryPath: NodePath.join(root, "missing-opencode"),
      },
    }).pipe(
      Effect.provideService(ProviderHost.ProviderHost, {
        ...host,
        environmentId: EnvironmentId.make("owner"),
      }),
      Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
        ...runtime,
        runOpenCodeCommand: (input) =>
          Effect.suspend(() => {
            commandCalls++;
            // A nonexistent absolute path fails at spawn with ENOENT; no child can hang.
            return available
              ? Effect.succeed({ stdout: "invalid version", stderr: "", code: 0 })
              : runtime.runOpenCodeCommand(input);
          }),
      }),
    );
    const input = GenerateMemorySummaryInput.make({
      cwd: root,
      sourceThread: {
        environmentId: EnvironmentId.make("source"),
        threadId: ThreadId.make("thread"),
      },
      sourceWatermark: {
        fromEventId: EventId.make("e1"),
        toEventId: EventId.make("e2"),
        throughSequence: 2,
      },
      messages: [{ messageId: MessageId.make("m1"), text: "hello", completed: true }],
      modelSelection: { instanceId: instance.instanceId, model: "openai/gpt-5" },
    });
    yield* instance.snapshot.refresh;
    const hold = yield* Hold.make;
    const key = yield* hold.keyFor(input.modelSelection);
    const second = GenerateMemorySummaryInput.make({
      ...input,
      sourceThread: { ...input.sourceThread, threadId: ThreadId.make("second-thread") },
    });
    const callsBeforeFailure = commandCalls;
    const failure = yield* hold
      .guard(key, instance.textGeneration.generateMemorySummary!(input))
      .pipe(Effect.flip);
    assert.strictEqual((yield* hold.status(key))?.reason, "unavailable");
    assert.isTrue(isMemoryGenerationRunnerError("cause" in failure ? failure.cause : undefined));
    assert.deepInclude("cause" in failure ? failure.cause : undefined, { code: "unavailable" });
    assert.isTrue(yield* hold.isHeld(key));
    const callsAfterFailure = commandCalls;
    assert.isAbove(callsAfterFailure, callsBeforeFailure);
    const held = yield* hold
      .guard(key, instance.textGeneration.generateMemorySummary!(second))
      .pipe(Effect.flip);
    assert.strictEqual(held._tag, "MemoryGenerationHeld");
    assert.strictEqual(commandCalls, callsAfterFailure);
    available = true;
    yield* TestClock.adjust(60_000);
    const probeFailure = yield* hold
      .guard(key, instance.textGeneration.generateMemorySummary!(second))
      .pipe(Effect.flip);
    assert.strictEqual(probeFailure._tag, "TextGenerationError");
    assert.isUndefined(Hold.deterministicFailure(probeFailure));
    assert.isAbove(commandCalls, callsAfterFailure);
    assert.isFalse(yield* hold.isHeld(key));
    assert.isUndefined(yield* hold.status(key));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        McpProviderSessions.layer,
        ProviderLatestVersions.layer,
        TestProviderHost.layer({ runBackgroundWork: false }),
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
        OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layerTest)),
      ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
    ),
  ),
);
