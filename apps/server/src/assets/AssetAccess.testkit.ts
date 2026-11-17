import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as GoatProjectFileLoader from "../project/GoatProjectFileLoader.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";

export const screenshotPng = new Uint8Array(24);
screenshotPng.set([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
new DataView(screenshotPng.buffer).setUint32(16, 390);
new DataView(screenshotPng.buffer).setUint32(20, 844);
export const screenshotItem = {
  id: TurnItemId.make("tool-screenshot"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  toolName: "mcp__t3-code__device_screenshot",
  input: { deviceId: "phone" },
  output: {
    content: [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from(screenshotPng).toString("base64"),
        },
      },
    ],
  },
  startedAt: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
};
export const oversizedScreenshotItem = {
  ...screenshotItem,
  id: TurnItemId.make("tool-screenshot-oversized"),
  output: {
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "A".repeat(14 * 1024 * 1024) },
      },
    ],
  },
};
const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "goat-asset-access-test-",
});
export const layerTest = Layer.mergeAll(
  NodeHttpPlatform.layer,
  Layer.mock(Orchestrator.OrchestratorV2)({
    getTurnItem: ({ itemId }) =>
      Effect.succeed(
        itemId === screenshotItem.id
          ? screenshotItem
          : itemId === oversizedScreenshotItem.id
            ? oversizedScreenshotItem
            : null,
      ),
  }),
  layerConfig,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(GoatProjectFileLoader.layer),
  ),
  NativeAppIconResolver.layer.pipe(Layer.provide(layerConfig)),
  ServerSecretStore.layer.pipe(Layer.provide(layerConfig)),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
