// @effect-diagnostics nodeBuiltinImport:off - ACP fixtures use Node HTTP servers and native paths
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import { layerTest, ACP_TEST_DRIVER } from "./AcpAdapterV2.host.testkit.ts";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { bundledMockAgentPath, makeMockRuntime } from "./AcpMockRuntime.testkit.ts";

describe("AcpAdapterV2 image attachments without image prompts", () => {
  it.live("sends an image to an agent without image prompts as a file path", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const host = yield* ProviderHost.ProviderHost;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* bundledMockAgentPath;
      const sent: Array<EffectAcpSchema.PromptRequest["prompt"]> = [];
      const instanceId = ProviderInstanceId.make("acp-test-image-without-image-prompts");
      const threadId = ThreadId.make("thread-acp-image-without-image-prompts");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              prompt: (payload, promptOptions) =>
                Effect.sync(() => void sent.push(payload.prompt)).pipe(
                  Effect.andThen(runtime.prompt(payload, promptOptions)),
                ),
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-image-without-prompts"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const screenshot = {
        type: "image",
        id: "screenshot-1",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 8,
      } as const;
      const screenshotPath = host.resolveAttachmentPath(screenshot);
      if (screenshotPath === null) return assert.fail("expected a screenshot path");
      yield* fileSystem.writeFile(
        screenshotPath,
        Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      );
      const base = makeTurnInput({
        threadId,
        providerThread,
        instanceId,
        runtimePolicy,
        now: yield* DateTime.now,
        messageText: "What is in this screenshot?",
      });

      yield* runtime.startTurn({
        ...base,
        message: { ...base.message, attachments: [screenshot] },
      });
      const terminal = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );

      assert.equal(Option.getOrThrow(terminal).status, "completed");
      const blocks = sent[0] ?? [];
      assert.deepEqual(
        blocks.filter((block) => block.type !== "text"),
        [],
      );
      assert.include(
        blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
        `[Attached image "screenshot.png" is saved at: ${screenshotPath}]`,
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
