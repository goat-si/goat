import type { ThreadId } from "@goat/contracts";
import type { SelfInvocation } from "@goat/shared/nodeRuntime";
import type * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as EffectAcpErrors from "effect-acp/errors";
import { acpMcpContext } from "./mcpContext.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

const LAUNCHER = [
  "@echo off",
  "setlocal EnableExtensions DisableDelayedExpansion",
  'set "ELECTRON_RUN_AS_NODE=1"',
  "if not defined GOAT_ACP_MCP_ENTRYPOINT goto packaged",
  '"%GOAT_ACP_MCP_NODE%" "%GOAT_ACP_MCP_ENTRYPOINT%" acp-mcp-call %*',
  "exit /b %errorlevel%",
  ":packaged",
  '"%GOAT_ACP_MCP_NODE%" acp-mcp-call %*',
  "exit /b %errorlevel%",
  "",
].join("\r\n");

export const writeAcpMcpCallLauncher = Effect.fn("AcpMcpCallLauncher.write")(function* (
  stateDir: string,
  isWindows: boolean,
) {
  if (!isWindows) return undefined;
  const fs = yield* FileSystem.FileSystem;
  const dir = NodePath.join(stateDir, "acp");
  const destination = NodePath.join(dir, "goat-acp-mcp-call.cmd");
  yield* fs.makeDirectory(dir, { recursive: true });
  const temporary = yield* fs.makeTempFile({ directory: dir, prefix: ".goat-acp-mcp-call-" });
  const cleanup = fs.remove(NodePath.dirname(temporary), { recursive: true, force: true });
  yield* fs.writeFileString(temporary, LAUNCHER).pipe(
    Effect.andThen(fs.rename(temporary, destination)),
    Effect.onError(() => cleanup.pipe(Effect.ignore)),
  );
  yield* cleanup;
  return destination;
});

export const makeAcpMcpContextReader = Effect.fn("AcpMcpCallLauncher.makeReader")(
  function* (input: {
    stateDir: string;
    isWindows: boolean;
    fileSystem: FileSystem.FileSystem;
    sessions: McpProviderSessions.McpProviderSessions["Service"];
    self: SelfInvocation;
    preferHttp: boolean | undefined;
  }) {
    const launcher = yield* writeAcpMcpCallLauncher(input.stateDir, input.isWindows).pipe(
      Effect.provideService(FileSystem.FileSystem, input.fileSystem),
      Effect.mapError(
        (cause) =>
          new EffectAcpErrors.AcpTransportError({
            detail: "Could not create ACP terminal tool launcher",
            cause,
          }),
      ),
      Effect.cached,
    );
    return (threadId: ThreadId | null) =>
      threadId === null
        ? Effect.succeed(acpMcpContext(undefined, input.self))
        : input.sessions
            .read(threadId)
            .pipe(
              Effect.flatMap((session) =>
                session === undefined
                  ? Effect.succeed(acpMcpContext(undefined, input.self))
                  : launcher.pipe(
                      Effect.map((path) =>
                        acpMcpContext(session, input.self, input.preferHttp, path),
                      ),
                    ),
              ),
            );
  },
);
