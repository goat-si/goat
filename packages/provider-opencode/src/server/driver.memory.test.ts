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

it.live("classifies a missing executable for the memory hold and retries after recovery", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const host = yield* ProviderHost.ProviderHost;
    const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
    let available = false;
    let recoveredProbes = 0;
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
          available
            ? Effect.sync(() => {
                recoveredProbes++;
                return { stdout: "1.18.32", stderr: "", code: 0 };
              })
            : runtime.runOpenCodeCommand(input),
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
    const failure = yield* instance.textGeneration.generateMemorySummary!(input).pipe(Effect.flip);
    assert.isTrue(isMemoryGenerationRunnerError(failure.cause));
    assert.deepInclude(failure.cause, { code: "unavailable" });
    available = true;
    yield* instance.textGeneration.generateMemorySummary!(input).pipe(Effect.exit);
    assert.isAbove(recoveredProbes, 0);
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
