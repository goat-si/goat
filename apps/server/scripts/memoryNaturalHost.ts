// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off - Standalone live fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as C from "@goat/contracts";
import * as Net from "@goat/shared/Net";
import { isolatedGitEnv } from "@goat/shared/testing/gitEnv";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

const decodeToken = Schema.decodeUnknownSync(C.AuthAccessTokenResult);
const decodeTicket = Schema.decodeUnknownSync(C.AuthWebSocketTicketResultJson);

export async function withNaturalHost<A>(
  use: (workspace: string, protocol: ReturnType<typeof socketProtocol>) => Promise<A>,
) {
  const port = await Effect.runPromise(Net.make().reserveLoopbackPort());
  await using root = await NodeFSP.mkdtempDisposable(
    NodePath.join(NodeOS.tmpdir(), "goat-memory-turn-"),
  );
  const workspace = NodePath.join(root.path, "workspace");
  await NodeFSP.mkdir(workspace);
  const origin = "http://127.0.0.1:" + port;
  const bootstrap = NodeCrypto.randomUUID();
  const server = NodeChildProcess.spawn(
    process.execPath,
    [
      NodeURL.fileURLToPath(new URL("../src/bin.ts", import.meta.url)),
      "start",
      "--bootstrap-fd",
      "3",
    ],
    {
      cwd: workspace,
      env: { ...isolatedGitEnv(), GOAT_TELEMETRY_ENABLED: "false" },
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    },
  );
  const closed = new Promise<void>((resolve) => server.once("close", () => resolve()));
  let spawnError: Error | undefined;
  server.once("error", (error) => {
    spawnError = error;
  });
  const abort = new AbortController();
  const stop = () => {
    abort.abort();
    server.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const pipe = server.stdio[3];
    if (!pipe || !("end" in pipe)) throw new Error("Missing desktop bootstrap pipe");
    pipe.end(
      JSON.stringify({
        mode: "desktop",
        noBrowser: true,
        port,
        host: "127.0.0.1",
        t3Home: NodePath.join(root.path, "goat"),
        desktopBootstrapToken: bootstrap,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      }),
    );
    const signal = AbortSignal.any([AbortSignal.timeout(60_000), abort.signal]);
    let token: string;
    for (;;) {
      signal.throwIfAborted();
      if (spawnError) throw spawnError;
      if (server.exitCode !== null || server.signalCode)
        throw new Error("Fixture exited during startup");
      const response = await fetch(origin + "/oauth/token", {
        method: "POST",
        redirect: "error",
        signal,
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: bootstrap,
          subject_token_type: C.AuthEnvironmentBootstrapTokenType,
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        }),
      }).catch(() => null);
      if (response && response.status !== 503) {
        if (!response.ok) throw new Error("Fixture authentication failed: HTTP " + response.status);
        token = decodeToken(await response.json()).access_token;
        break;
      }
      await NodeTimersPromises.setTimeout(500, undefined, { signal });
    }
    const response = await fetch(origin + "/api/auth/websocket-ticket", {
      method: "POST",
      redirect: "error",
      headers: { Authorization: "Bearer " + token },
      signal,
    });
    if (!response.ok) throw new Error("Fixture ticket failed: HTTP " + response.status);
    const { ticket } = decodeTicket(await response.json());
    const ws = new URL("/ws", origin.replace("http:", "ws:"));
    ws.searchParams.set(
      C.ORCHESTRATION_PROTOCOL_QUERY_PARAM,
      String(C.ORCHESTRATION_PROTOCOL_VERSION),
    );
    ws.searchParams.set("wsTicket", Redacted.value(ticket));
    return await use(workspace, socketProtocol(ws.href));
  } finally {
    stop();
    const force = setTimeout(() => server.kill("SIGKILL"), 8000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
}

function socketProtocol(url: string) {
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(RpcSerialization.layerJson),
  );
}
