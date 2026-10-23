// The fake SSH manager and remote /mcp that SshRemoteDispatch.callHostTool tests drive.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { vi } from "@effect/vitest";
import * as SshConfig from "@goat/ssh/config";
import { SshCommandError } from "@goat/ssh/errors";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";

export const host = "build-box";
const target = { alias: host, hostname: host, username: null, port: null };

export type ToolAnswer =
  | { readonly status: number }
  | { readonly result: unknown }
  | { readonly rpcError: string }
  | { readonly throws: string };

/**
 * Runs body against a dispatch whose SSH manager and remote /mcp are fakes.
 * `answer` decides each HTTP request; the record says what reached the remote.
 */
export const withRemote = <A, E>(
  options: {
    readonly answer: (request: {
      readonly method: string;
      readonly tool?: string;
      readonly authorization: string | null;
    }) => ToolAnswer | Promise<ToolAnswer>;
    readonly beforeSessionIssue?: (attempt: number) => Effect.Effect<void, SshCommandError>;
    readonly ensureFails?: boolean;
    readonly ceilingApplied?: boolean;
    /** The remote CLI cannot grant orchestration:approve. */
    readonly approvalsFail?: boolean;
    /** The serverVersion the remote reports; omitted means this machine cannot tell. */
    readonly serverVersion?: string;
  },
  body: Effect.Effect<A, E, SshRemoteDispatch.SshRemoteDispatch>,
) =>
  Effect.gen(function* () {
    const record = {
      toolCalls: [] as string[],
      sessionsIssued: 0,
      requests: 0,
      sessionRequests: [] as Array<boolean>,
      providersManageRequests: [] as Array<boolean>,
    };
    const fetchEndpoint = vi.fn(async (_url: string, init?: RequestInit) => {
      record.requests += 1;
      const request = JSON.parse(String(init?.body)) as {
        id?: string;
        method: string;
        params?: { name?: string };
      };
      if (request.method === "tools/call") record.toolCalls.push(request.params?.name ?? "");
      const answer = await options.answer({
        method: request.method,
        authorization: new Headers(init?.headers).get("authorization"),
        ...(request.params?.name === undefined ? {} : { tool: request.params.name }),
      });
      if ("throws" in answer) throw new TypeError(answer.throws);
      if ("status" in answer) return new Response(null, { status: answer.status });
      if (request.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if ("rpcError" in answer) {
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: answer.rpcError },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result: answer.result });
    });
    const manager = SshTunnel.SshEnvironmentManager.of({
      status: () => Effect.die("Unexpected runtime status"),
      ensureEnvironment: () =>
        options.ensureFails === true
          ? Effect.fail(
              new SshCommandError({
                message: "ssh: connect to host build-box port 22: Operation timed out",
                command: ["ssh", host],
                exitCode: 255,
                stderr: "",
              }),
            )
          : Effect.succeed({
              target,
              httpBaseUrl: "http://127.0.0.1:41000/",
              wsBaseUrl: "ws://127.0.0.1:41000/",
              pairingToken: null,
              ...(options.serverVersion === undefined
                ? {}
                : { remoteServerVersion: options.serverVersion }),
            }),
      readyEnvironment: () =>
        Effect.succeed({
          target,
          httpBaseUrl: "http://127.0.0.1:41000/",
          wsBaseUrl: "ws://127.0.0.1:41000/",
          pairingToken: null,
          ...(options.serverVersion === undefined
            ? {}
            : { remoteServerVersion: options.serverVersion }),
        }),
      beginSetupOperation: () => Effect.die("Unexpected setup operation"),
      publishSetupOutcome: () => Effect.succeed(true),
      publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
      forgetEnvironment: () => Effect.die("Unexpected forget"),
      disconnectEnvironment: () => Effect.die("Unexpected SSH disconnect"),
      revalidateTunnels: () => Effect.void,
      issueClientSession: () => Effect.die("unused"),
      issueMcpClientSession: (_target, sessionOptions) => {
        record.sessionRequests.push(sessionOptions.approvals === true);
        record.providersManageRequests.push(sessionOptions.providersManage === true);
        return sessionOptions.approvals === true && options.approvalsFail === true
          ? Effect.fail(
              new SshCommandError({
                message: "unknown option value: orchestration:approve",
                command: ["ssh", host],
                exitCode: 2,
                stderr: "",
              }),
            )
          : Effect.gen(function* () {
              yield* options.beforeSessionIssue?.(record.sessionRequests.length) ?? Effect.void;
              record.sessionsIssued += 1;
              return {
                token: `session-${record.sessionsIssued}`,
                expiresAt: null,
                runtimeModeCeilingApplied: options.ceilingApplied ?? true,
              };
            });
      },
      runRemoteScript: () => Effect.die("Unexpected remote script"),
    });
    const discoverHosts = vi
      .spyOn(SshConfig, "discoverSshHosts")
      .mockReturnValue(Effect.succeed([{ ...target, source: "ssh-config" }]));
    const managerLayer = vi
      .spyOn(SshTunnel.SshEnvironmentManager, "layer")
      .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
    vi.stubGlobal("fetch", fetchEndpoint);
    try {
      const result = yield* body.pipe(
        Effect.result,
        Effect.provide(
          SshRemoteDispatch.layer.pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-host-call-test-" })),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      return { result, record };
    } finally {
      vi.unstubAllGlobals();
      managerLayer.mockRestore();
      discoverHosts.mockRestore();
    }
  });

export const initialize = (request: { readonly method: string }): ToolAnswer | undefined =>
  request.method === "initialize"
    ? {
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "GOAT", version: "test" },
        },
      }
    : request.method === "notifications/initialized"
      ? { result: null }
      : undefined;
