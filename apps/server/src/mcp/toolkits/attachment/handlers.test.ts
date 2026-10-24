import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { McpSchema, McpServer } from "effect/ai";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("mcp-attachment-environment"),
  requestNamespace: "mcp-attachment-session",
  thread: {
    threadId: ThreadId.make("mcp-attachment-thread"),
    providerSessionId: "mcp-attachment-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-attachment", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-attachment", version: "1" },
  },
  getClient: Effect.die("unused"),
});

// A declared tool failure arrives as isError with its encoded payload as JSON text.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

// Each obstacle makes removal fail; a lookup error must not read as a missing file.
const obstacles = [
  {
    name: "a directory where the file belongs",
    block: (fs: FileSystem.FileSystem, folder: string, file: string) =>
      fs.makeDirectory(file, { recursive: true }),
    unblock: (fs: FileSystem.FileSystem, folder: string, file: string) =>
      fs.remove(file, { recursive: true }),
  },
  {
    name: "an attachments folder that is not a directory",
    block: (fs: FileSystem.FileSystem, folder: string) =>
      fs
        .remove(folder, { recursive: true, force: true })
        .pipe(Effect.andThen(fs.writeFileString(folder, ""))),
    unblock: (fs: FileSystem.FileSystem, folder: string) =>
      fs.remove(folder).pipe(Effect.andThen(fs.makeDirectory(folder, { recursive: true }))),
  },
];

it.effect.each(obstacles)(
  "a discard blocked by $name keeps ownership so the caller can retry",
  ({ block, unblock }) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const fs = yield* FileSystem.FileSystem;
      const folder = (yield* ServerConfig.ServerConfig).attachmentsDir;
      const call = (name: string, args: Record<string, unknown>) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      const prepared = yield* call("goat_attachment_prepare_upload", {
        upload: { name: "shot.png", mimeType: "image/png", sizeBytes: 4 },
      });
      const { attachmentId } = prepared.structuredContent as { readonly attachmentId: string };
      yield* block(fs, folder, folder + "/" + attachmentId + ".png");

      const failed = yield* call("goat_attachment_discard", { attachmentId });
      expect(declaredFailure(failed)).toMatchObject({ code: "orchestration_error" });

      yield* unblock(fs, folder, folder + "/" + attachmentId + ".png");
      const retried = yield* call("goat_attachment_discard", { attachmentId });
      expect(retried.isError).toBe(false);
      const again = yield* call("goat_attachment_discard", { attachmentId });
      expect(declaredFailure(again)).toMatchObject({ code: "invalid_request" });
    }).pipe(
      Effect.provide(
        McpHttpServer.layerAttachmentToolkit.pipe(
          Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(ServerSecretStore.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "goat-mcp-attachment-" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
