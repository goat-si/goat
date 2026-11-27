// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off
import * as NodeCrypto from "node:crypto";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_HEADER,
  ProviderInstanceId,
  WsRpcGroup,
} from "@goat/contracts";
import type { ModelSelection } from "./core.ts";

export async function botEvalSession(origin: string, bearer: string) {
  const headers = {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  };
  const request = async (path: string, method: string, body?: unknown) => {
    const response = await fetch(origin + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  };
  const { ticket } = (await request("/api/auth/websocket-ticket", "POST")) as { ticket: string };
  const url = new URL("/ws", origin);
  url.protocol = "ws:";
  url.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION));
  url.searchParams.set("wsTicket", ticket);
  const socket = Socket.layerWebSocket(url.href).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(socket),
    Layer.provide(RpcSerialization.layerJson),
  );
  const run = <A, E>(
    execute: (
      client: RpcClient.FromGroup<
        typeof WsRpcGroup,
        import("effect/rpc/RpcClientError").RpcClientError
      >,
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(WsRpcGroup);
        return yield* execute(client);
      }).pipe(Effect.provide(protocol), Effect.scoped),
    );
  return {
    launch: async (selection: ModelSelection, message: string) => {
      const requestId = NodeCrypto.randomUUID();
      const messageId = NodeCrypto.randomUUID();
      const receivedAt = new Date().toISOString();
      const { receipt, botThreadId } = await run((client) =>
        Effect.gen(function* () {
          const { bot } = yield* client["channel.createBot"]({
            clientRequestId: requestId,
            name: "Delegation outcome eval " + requestId.slice(0, 8),
            avatar: null,
            purpose: "",
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make(selection.instanceId),
              model: selection.model,
            },
          });
          const receipt = yield* client["channel.ingest"]({
            kind: "goat",
            connectionId: "goat",
            conversationKey: bot.sessionThreadId,
            externalMessageId: messageId,
            idempotencyKey: messageId,
            actor: {},
            replyAddress: {
              kind: "goat",
              environmentId: bot.environmentId,
              threadId: bot.sessionThreadId,
            },
            text: message,
            attachments: [],
            receivedAt,
            intent: "message",
          });
          return { receipt, botThreadId: bot.sessionThreadId };
        }),
      );
      if (receipt.state === "rejected") throw new Error("Bot rejected the eval message");
      return { inputId: receipt.inputId, botThreadId };
    },
  };
}
