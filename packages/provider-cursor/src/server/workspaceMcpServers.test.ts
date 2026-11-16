import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { spawnAndCollect } from "@goat/provider-core/server/snapshotProbe";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as HostProcess from "@goat/shared/HostProcess";
import { symlinksSupported } from "@goat/shared/testing/symlinks";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Schema from "effect/Schema";

import { CursorSettings } from "../settings.ts";
import { cursorMcpServers, makeCursorAdapterV2 } from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import { cursorWorkspaceMcpServers } from "./workspaceMcpServers.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

it.effect.skipIf(!symlinksSupported)(
  "starts mcp.json servers that use Cursor's workspace variables",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const scratch = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-mcp-" }),
      );
      const workspace = path.join(scratch, "workspace");
      const home = path.join(scratch, "home");
      const loadServers = () =>
        cursorWorkspaceMcpServers(cwd, { MCP_TYPE: "stdio" }).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Environment, {}),
        );
      // Cursor resolves the project root through symlinks, as git does.
      yield* fileSystem.makeDirectory(path.join(workspace, "packages", "app"), {
        recursive: true,
      });
      yield* fileSystem.symlink(workspace, path.join(scratch, "link"));
      const cwd = path.join(scratch, "link", "packages", "app");
      yield* spawnAndCollect("git", ChildProcess.make("git", ["init", workspace]));
      // Git prints forward slashes on Windows, and the loader passes its spelling through.
      const projectRoot = (yield* spawnAndCollect(
        "git",
        ChildProcess.make("git", ["rev-parse", "--show-toplevel"], { cwd }),
      )).stdout.trim();
      yield* fileSystem.makeDirectory(path.join(workspace, ".cursor"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(home, ".cursor"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(workspace, ".cursor", "mcp.json"),
        `{
        // Cursor's editor accepts comments here.
        "mcpServers": {
          "repro": { "command": "node", "args": ["\${workspaceFolder}/server.mjs"], "startupTimeoutSec": 120 },
          "plain": { "command": "node", "args": ["server.mjs"] },
          "argument-only": { "command": "node", "args": ["server.mjs", "--workspace", "\${workspaceFolder}"] },
          "env-only": { "command": "node", "args": ["server.mjs"], "env": { "PROJECT_ROOT": "\${workspaceFolder}" } },
          "cwd-only": { "command": "node", "args": ["server.mjs"], "cwd": "\${workspaceFolder}" },
          "unset-env": { "command": "node", "env": { "CONFIG": "\${env:T3_MCP_UNSET}" } },
          "wrapped": { "command": "proto", "args": ["run", "node", "--", "\${workspaceFolder}/server.mjs"] },
          "label": { "command": "node", "args": ["server.mjs", "--label", "\${workspaceFolder}/client"] },
          "env-file": { "command": "node", "args": ["\${workspaceFolder}/server.mjs"], "envFile": ".env.mcp" },
          "tool-filter": { "command": "node", "args": ["\${workspaceFolder}/server.mjs"], "enabledTools": ["read_file"] },
          "off": { "command": "node", "args": ["\${workspaceFolder}/off.mjs"] },
          "typed": { "type": "\${env:MCP_TYPE}", "command": "node", "args": ["server.mjs"] },
          "plugin-docs-search": { "command": "node", "args": ["\${workspaceFolder}/search.mjs"] },
        },
      }`,
      );
      yield* fileSystem.writeFileString(
        path.join(home, ".cursor", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            repro: { command: "node", args: ["${userHome}/shadowed.mjs"] },
            docs: {
              url: "https://docs.example/${workspaceFolderBasename}",
              headers: { Authorization: "Bearer ${env:DOCS_TOKEN}" },
              tls: { caBundle: "${userHome}/ca.pem" },
            },
          },
        }),
      );
      // Cursor keeps per-project state under a directory named after the project path.
      const projectDirectory = workspace.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
      yield* fileSystem.makeDirectory(path.join(home, ".cursor", "projects", projectDirectory), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        path.join(home, ".cursor", "projects", projectDirectory, "mcp-disabled.json"),
        JSON.stringify(["off"]),
      );

      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-mcp-thread");
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      yield* mcpSessions.set({
        environmentId: EnvironmentId.make("cursor-mcp-environment"),
        threadId,
        providerSessionId: "cursor-mcp-session",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer synthetic-cursor-token",
        browserToolsAvailable: false,
      });
      const goatServers = cursorMcpServers(yield* mcpSessions.read(threadId));
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd,
      });
      let openedWith: CursorAgentSdk.CursorAgentSdkOpenInput["options"] | undefined;
      const sentWith: Array<Record<string, unknown> | undefined> = [];
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        settings: yield* decodeCursorSettings({}),
        environment: {
          HOME: path.join(scratch, "override"),
          CURSOR_DATA_DIR: path.join(scratch, "override"),
          DOCS_TOKEN: "docs-token",
          MCP_TYPE: "stdio",
        },
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: (input) =>
            Effect.sync(() => {
              openedWith = input.options;
              return {
                agentId: "native-cursor-mcp",
                listMessages: Effect.succeed([]),
                close: Effect.void,
                send: (sendInput) => {
                  sentWith.push(sendInput.options?.mcpServers);
                  return Effect.die("sent");
                },
              };
            }),
        }),
        Effect.provide(TestProviderHost.layer({ cwd })),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-mcp-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime
        .ensureThread({ threadId, modelSelection, runtimePolicy })
        .pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Environment, {}),
        );
      const now = yield* DateTime.now;
      const sendTurn = (ordinal: number) =>
        runtime
          .startTurn({
            threadId,
            providerThread,
            modelSelection,
            runtimePolicy,
            runId: RunId.make(`cursor-mcp-run-${ordinal}`),
            runOrdinal: ordinal,
            providerTurnOrdinal: ordinal,
            attemptId: RunAttemptId.make(`cursor-mcp-attempt-${ordinal}`),
            rootNodeId: NodeId.make(`cursor-mcp-root-${ordinal}`),
            appThread: {
              id: threadId,
              projectId: ProjectId.make("cursor-mcp-project"),
              createdBy: "user",
              creationSource: "web",
              title: "Cursor MCP",
              providerInstanceId: instanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: providerThread.id,
              lineage: {
                parentThreadId: null,
                relationshipToParent: null,
                rootThreadId: threadId,
              },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
            message: {
              messageId: MessageId.make(`cursor-mcp-message-${ordinal}`),
              createdBy: "user",
              creationSource: "web",
              text: "Hello.",
              attachments: [],
            },
          })
          .pipe(
            Effect.exit,
            Effect.provideService(HostProcess.HomeDirectory, home),
            Effect.provideService(HostProcess.Environment, {}),
          );

      const expectedServers = {
        repro: {
          command: "node",
          args: [`${projectRoot}/server.mjs`],
          startupTimeoutSec: 120,
          cwd: projectRoot,
        },
        "cwd-only": { command: "node", args: ["server.mjs"], cwd: projectRoot },
      };
      // The agent is created with GOAT's server only; the resolved servers go with each turn.
      assert.deepEqual(openedWith?.mcpServers, goatServers);
      yield* sendTurn(1);
      assert.deepEqual(sentWith[0], { ...expectedServers, ...goatServers });
      // A server switched off between turns stays off on the next one.
      yield* fileSystem.writeFileString(
        path.join(home, ".cursor", "projects", projectDirectory, "mcp-disabled.json"),
        JSON.stringify(["off", "repro"]),
      );
      yield* sendTurn(2);
      const { repro: _disabled, ...stillEnabled } = expectedServers;
      assert.deepEqual(sentWith[1], { ...stillEnabled, ...goatServers });
      // Unreadable disabled state starts none of the overrides, and the turn still goes out.
      yield* fileSystem.writeFileString(
        path.join(home, ".cursor", "projects", projectDirectory, "mcp-disabled.json"),
        "[",
      );
      yield* sendTurn(3);
      assert.deepEqual(sentWith[2], goatServers);
      yield* fileSystem.writeFileString(
        path.join(workspace, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { plain: { command: "node", args: ["server.mjs"] } } }),
      );
      yield* fileSystem.remove(path.join(home, ".cursor", "mcp.json"));
      assert.deepEqual(yield* loadServers(), {});
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
);
