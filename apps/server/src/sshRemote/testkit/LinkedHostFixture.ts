// A real SshRemoteDispatch with one linked host: link admission runs as in production, and
// `answer` plays the host's /mcp. Nothing may reach SSH.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { vi } from "@effect/vitest";
import * as SshConfig from "@goat/ssh/config";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as LinkedHosts from "../../linkedHosts/LinkedHosts.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SshRemoteDispatch from "../SshRemoteDispatch.ts";

const LINK: LinkedHosts.LinkedHostCredential = {
  host: {
    name: "box",
    baseUrl: "https://box.example.ts.net",
    environmentId: "env-box",
    label: "Build box",
    serverVersion: "0.1.0-test",
    access: "approval-required",
    linkedAt: "2026-10-19T00:00:00.000Z",
    expiresAt: "2026-11-18T00:00:00.000Z",
  },
  token: "link-token",
};

export type Answer =
  | { readonly status: number }
  | { readonly result: unknown }
  | { readonly rpcError: string };

/**
 * Runs body against a dispatch with one linked host and an SSH manager that
 * fails the test if anything reaches it. `answer` plays the host's /mcp.
 */
export const withLinkedHost = <A, E, R>(
  answer: (request: {
    readonly method: string;
    readonly tool?: string;
    readonly args?: unknown;
  }) => Answer,
  body: Effect.Effect<A, E, R>,
  serverVersion = LINK.host.serverVersion,
  access: LinkedHosts.LinkedHost["access"] = LINK.host.access,
) =>
  Effect.gen(function* () {
    const link = { ...LINK, host: { ...LINK.host, serverVersion, access } };
    const record: Array<{
      url: string;
      authorization: string | null;
      method: string;
      tool?: string;
    }> = [];
    const fetchEndpoint = vi.fn(async (url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        id?: string;
        method: string;
        params?: { name?: string; arguments?: unknown };
      };
      record.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        method: request.method,
        ...(request.params?.name === undefined ? {} : { tool: request.params.name }),
      });
      if (request.method === "initialize")
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "GOAT", version: "test" },
          },
        });
      if (request.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      const reply = answer({
        method: request.method,
        ...(request.params?.name === undefined ? {} : { tool: request.params.name }),
        args: request.params?.arguments,
      });
      if ("status" in reply) return new Response(null, { status: reply.status });
      if ("rpcError" in reply)
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: reply.rpcError },
        });
      return Response.json({ jsonrpc: "2.0", id: request.id, result: reply.result });
    });
    const noSsh = () => Effect.die("A linked host must not use SSH");
    const manager = SshTunnel.SshEnvironmentManager.of({
      status: noSsh,
      ensureEnvironment: noSsh,
      readyEnvironment: noSsh,
      beginSetupOperation: noSsh,
      publishSetupOutcome: noSsh,
      publishProviderDiagnosis: noSsh,
      forgetEnvironment: noSsh,
      disconnectEnvironment: noSsh,
      revalidateTunnels: () => Effect.void,
      issueClientSession: () => Effect.die("unused"),
      issueMcpClientSession: noSsh,
      runRemoteScript: noSsh,
    });
    const links = LinkedHosts.LinkedHosts.of({
      changes: Stream.empty,
      list: Effect.succeed([link.host]),
      find: (name) => Effect.succeed(name === "box" ? Option.some(link) : Option.none()),
      names: Effect.succeed(["box"]),
      link: () => Effect.die("unused"),
      unlink: () => Effect.die("unused"),
    });
    const discoverHosts = vi
      .spyOn(SshConfig, "discoverSshHosts")
      .mockReturnValue(Effect.succeed([]));
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
            Layer.provide(Layer.succeed(LinkedHosts.LinkedHosts, links)),
            Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-linked-dispatch-" })),
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
