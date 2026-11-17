import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { RunAttemptId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexReplayTranscript, makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

const layerAdapterTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
  NodeCrypto.layer,
);

describe("CodexAdapterV2 image views", () => {
  it.effect("keeps native image views available to the clients", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "image-view-thread";
        const nativeTurnId = "image-view-turn";
        const imagePath = "file:///workspace/reference.png";
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "image-view",
            entries: [
              ...codexReplayPreamble({
                nativeThreadId,
                nativeTurnId,
                prompt: "Show the reference.",
              }),
              ...(["started", "completed"] as const).map((phase) => ({
                type: "emit_inbound" as const,
                label: `image ${phase}`,
                frame: {
                  method: `item/${phase}`,
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    item: { type: "imageView", id: "image-view", path: imagePath },
                    ...(phase === "started" ? { startedAtMs: 1 } : { completedAtMs: 2 }),
                  },
                },
              })),
              {
                type: "emit_inbound",
                label: "turn completed",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                  },
                },
              },
            ],
          }),
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("image-view-attempt"),
            text: "Show the reference.",
          }),
        );
        yield* harness.firstTerminal;
        const images = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
            ? [event.turnItem]
            : [],
        );
        assert.lengthOf(images, 1);
        assert.equal(images[0]?.viewedImagePath, imagePath);
        assert.equal(images[0]?.status, "completed");
      }).pipe(Effect.provide(layerAdapterTest)),
    ),
  );
});
