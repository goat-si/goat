import { expect, it } from "@effect/vitest";
import {
  DeviceSession,
  DeviceSummary,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as DeviceService from "../../../device/DeviceService.ts";
import { catalog, client, dependencies, deviceAccessGranted } from "../../agentSurface.testkit.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const png = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
]);
const device = Layer.mock(DeviceService.DeviceService)({
  sessionsForThread: (threadId) =>
    Effect.succeed([
      Schema.decodeUnknownSync(DeviceSession)({
        threadId,
        hostId: "local",
        deviceId: "device-1",
        platform: "ios",
        openedAt: "2026-10-23T00:00:00.000Z",
      }),
    ]),
  screenshot: () =>
    Effect.succeed({
      device: Schema.decodeUnknownSync(DeviceSummary)({
        hostId: "local",
        id: "device-1",
        platform: "ios",
        name: "iPhone",
        version: "27.0",
        booted: true,
        physical: false,
      }),
      png,
    }),
});
const registered = catalog.pipe(
  Layer.provide(Layer.mergeAll(dependencies, deviceAccessGranted, device)),
  Layer.provideMerge(McpServer.McpServer.layer),
);

const thread = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "provider:thread",
  thread: {
    threadId: ThreadId.make("thread"),
    providerSessionId: "provider:thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "device"] as const),
  issuedAt: 0,
};

it.effect("returns an image tool's image through goat_call as an image block, not as JSON", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const direct = yield* server.callTool({ name: "goat_device_screenshot", arguments: {} });
    const called = yield* server.callTool({
      name: "goat_call",
      arguments: { path: "device.screenshot", args: {} },
    });
    const images = (result: McpSchema.CallToolResult) =>
      result.content.filter((block) => block.type === "image");
    expect(images(direct)).toHaveLength(1);
    expect(images(called)).toEqual(images(direct));
    // The envelope keeps the value and loses only the copy that moved to the content.
    expect(called.structuredContent).toMatchObject({ status: "ok" });
    expect(JSON.stringify(called.structuredContent)).not.toContain(
      Buffer.from(png).toString("base64"),
    );
  }).pipe(
    Effect.provideService(McpInvocationContext, thread),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provide(registered),
  ),
);
