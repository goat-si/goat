// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off -- owns a disposable loopback server and its startup deadline.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeTimersPromises from "node:timers/promises";
import {
  AuthEnvironmentBootstrapTokenType,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";

const decodeToken = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }));
const decodeTicket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }));

export async function withEvalServer<T>(
  run: (host: {
    root: string;
    origin: string;
    headers: Record<string, string>;
    rpc: ReturnType<typeof rpcLayer>;
  }) => Promise<T>,
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-preference-eval-"));
  const reservation = NodeNet.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address();
      if (!address || typeof address === "string") throw new Error("No loopback port");
      reservation.close(() => resolve(address.port));
    });
  });
  const origin = "http://127.0.0.1:" + port;
  const bootstrap = NodeCrypto.randomUUID();
  const server = NodeChildProcess.spawn(
    process.execPath,
    [NodePath.resolve(import.meta.dirname, "../../src/bin.ts"), "start", "--bootstrap-fd", "3"],
    {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore", "pipe"],
      env: { ...process.env, GOAT_TELEMETRY_ENABLED: "false" },
    },
  );
  let spawnError: Error | undefined;
  server.once("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise<void>((resolve) => {
    server.once("close", () => resolve());
  });
  const shutdown = () => {
    server.kill("SIGTERM");
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    const pipe = server.stdio[3];
    if (!pipe || !("end" in pipe)) throw new Error("No bootstrap pipe");
    pipe.end(
      JSON.stringify({
        mode: "desktop",
        host: "127.0.0.1",
        port,
        goatHome: NodePath.join(root, "goat"),
        noBrowser: true,
        desktopBootstrapToken: bootstrap,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      }),
    );
    const deadline = AbortSignal.timeout(180_000);
    let response: Response | undefined;
    while (server.exitCode === null && server.signalCode === null && !response) {
      if (spawnError) throw spawnError;
      deadline.throwIfAborted();
      response = await fetch(origin + "/oauth/token", {
        method: "POST",
        signal: deadline,
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: bootstrap,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        }),
      }).catch(() => undefined);
      if (response?.status === 503) {
        await response.body?.cancel();
        response = undefined;
      }
      if (!response) await NodeTimersPromises.setTimeout(200);
    }
    if (spawnError) throw spawnError;
    if (!response?.ok)
      throw new Error(
        "Disposable server bootstrap failed: " + (response?.status ?? server.exitCode),
      );
    const token = decodeToken(await response.json());
    const headers = {
      Authorization: "Bearer " + token.access_token,
      "Content-Type": "application/json",
      [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
    };
    const ticketResponse = await fetch(origin + "/api/auth/websocket-ticket", {
      method: "POST",
      headers,
      signal: deadline,
    });
    if (!ticketResponse.ok) throw new Error("WebSocket ticket failed: " + ticketResponse.status);
    const { ticket } = decodeTicket(await ticketResponse.json());
    return await run({ root, origin, headers, rpc: rpcLayer(origin, ticket) });
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    shutdown();
    const force = setTimeout(() => server.kill("SIGKILL"), 10_000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}
function rpcLayer(origin: string, ticket: string) {
  const url = new URL("/ws", origin);
  url.protocol = "ws:";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION));
  return RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
    Layer.provide(
      Socket.layerWebSocket(url.href).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
}
