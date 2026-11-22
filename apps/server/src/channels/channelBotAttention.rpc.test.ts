import * as NodeWS from "@effect/platform-node/NodeWS";
import { expect, it } from "@effect/vitest";
import {
  CHANNEL_GATEWAY_WS_METHODS,
  BotId,
  ChannelAnsweredQuestion,
  ChannelGetTaskInput,
  ChannelInboundMessage,
  ChannelTask,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  RpcScopeAuthorization,
  WsChannelRpcGroup,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { Socket } from "effect/socket";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import * as Runtime from "../auth/ConnectHubRuntime.testkit.ts";
import * as HubRpcSocket from "../auth/HubRpcSocket.ts";
import { MAIN_LISTENER } from "../auth/connectionContext.testkit.ts";
import { serve } from "../hubProxy/testFixtures.ts";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { readTaskForAttention } from "./channelBotAttention.ts";
import { ownerFromSession } from "./channelOwner.ts";

const { getTask, listBotAttention } = CHANNEL_GATEWAY_WS_METHODS;
const tags = [...WsChannelRpcGroup.requests.values()].map((rpc) => rpc._tag);
const attentionRpcs = WsChannelRpcGroup.omit(
  ...tags.filter(
    (tag): tag is Exclude<typeof tag, typeof getTask | typeof listBotAttention> =>
      tag !== getTask && tag !== listBotAttention,
  ),
);
const oldGetTask = Rpc.make(getTask, {
  payload: Schema.Struct({
    taskId: ChannelGetTaskInput.fields.taskId,
  }),
  success: ChannelTask.mapFields((fields) => ({
    ...fields,
    answeredQuestions: Schema.optional(
      Schema.Array(ChannelAnsweredQuestion.mapFields(Struct.omit(["answerText"]))),
    ),
  })),
}).middleware(RpcScopeAuthorization);
const oldRpcs = RpcGroup.make(oldGetTask);

const environmentId = EnvironmentId.make("attention-rpc");
const date = "2026-11-21T00:00:00.000Z";
const task = Schema.decodeSync(ChannelTask)({
  taskId: "task",
  conversationId: "conversation",
  originBindingId: "binding",
  originInputId: "input",
  originAddress: { kind: "goat", environmentId, threadId: "bot" },
  requester: {
    ownerId: "environment:attention-rpc",
    principalId: "person",
    displayName: "Owner",
    originKind: "goat",
    runtimeModeCeiling: "full-access",
    grantedScopes: ["orchestration:read"],
  },
  title: "Private task",
  instruction: "Review it",
  status: "waiting_input",
  version: 2,
  generation: 1,
  openQuestions: [],
  answeredQuestions: [{ questionId: "ask", inputId: "answer" }],
  createdAt: date,
  updatedAt: date,
});

const connect = Effect.fnUntraced(function* <Rpcs extends Rpc.Any>(
  rpcs: RpcGroup.RpcGroup<Rpcs>,
  url: string,
) {
  const socket = yield* Socket.makeWebSocket(url).pipe(
    Effect.provide(NodeWS.layerWebSocketConstructor),
  );
  const protocol = yield* RpcClient.makeProtocolSocket({ retryTransientErrors: false }).pipe(
    Effect.provideService(Socket.Socket, socket),
    Effect.provide(RpcSerialization.layerJson),
  );
  return yield* RpcClient.make(rpcs).pipe(Effect.provideService(RpcClient.Protocol, protocol));
});

const decodeInbound = Schema.decodeSync(ChannelInboundMessage);

const setup = Effect.fnUntraced(function* (legacy: boolean, answerOwner = task.requester.ownerId) {
  const sql = yield* SqlClient.SqlClient;
  const message = decodeInbound({
    kind: "goat",
    connectionId: "goat",
    conversationKey: "conversation",
    externalMessageId: "answer",
    idempotencyKey: "answer",
    actor: {},
    replyAddress: task.originAddress,
    text: "West",
    attachments: [],
    receivedAt: date,
    intent: "answer",
    taskId: task.taskId,
    questionId: "ask",
  });
  yield* sql`INSERT INTO channel_conversations
    (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at)
    VALUES ('conversation', ${answerOwner}, 'goat', 'goat', 'conversation', ${date})`;
  yield* sql`INSERT INTO channel_bindings
    (binding_id, conversation_id, connection_id, reply_address_json, last_activity_at)
    VALUES ('binding', 'conversation', 'goat', ${JSON.stringify(message.replyAddress)}, ${date})`;
  yield* sql`INSERT INTO channel_inbox
    (input_id, owner_id, kind, connection_id, idempotency_key, content_hash, conversation_id,
      binding_id, message_json, state, accepted_at)
    VALUES ('answer', ${answerOwner}, 'goat', 'goat', 'answer', 'hash', 'conversation',
      'binding', ${JSON.stringify(message)}, 'replied', ${date})`;
  const sourceLedger = yield* ChannelLedger.ChannelLedger.pipe(Effect.provide(ChannelLedger.layer));
  const runtime = yield* Runtime.open();
  let reads = 0;
  const routes = HubRpcSocket.layer((session) =>
    Effect.gen(function* () {
      const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
      const owner = ownerFromSession(environmentId, session);
      const ledger = Layer.mock(ChannelLedger.ChannelLedger)({
        getInput: sourceLedger.getInput,
        getTask: () =>
          Effect.sync(() => {
            reads += 1;
            return {
              ownerId: owner.ownerId,
              botId: BotId.make("main"),
              task,
              pendingAnswerMessageId: undefined,
              completionHold: undefined,
            };
          }),
      });
      const read = (input: typeof ChannelGetTaskInput.Type) =>
        ChannelLedger.ChannelLedger.use((service) =>
          readTaskForAttention(service, input, owner.ownerId),
        ).pipe(Effect.provide(ledger));
      const members = yield* ChannelBotMembers.ChannelBotMembers.pipe(
        Effect.provide(
          Layer.mock(ChannelBotMembers.ChannelBotMembers)({
            attentionFeed: () =>
              Effect.sync(() => {
                reads += 1;
                return { cursor: 7, events: [], hasMore: false, mode: "needs_you" as const };
              }),
          }),
        ),
      );
      const effects = legacy
        ? RpcServer.make(oldRpcs).pipe(
            Effect.provide(
              oldRpcs.toLayer({
                [getTask]: (input) => read(input).pipe(Effect.orDie),
              }),
            ),
          )
        : RpcServer.make(attentionRpcs).pipe(
            Effect.provide(
              attentionRpcs.toLayer({
                [getTask]: read,
                [listBotAttention]: ChannelBotMembers.rpcHandlers(members, owner, Effect.void)[
                  listBotAttention
                ],
              }),
            ),
          );
      yield* effects.pipe(
        Effect.provide(HubRpcSocket.rpcAuthorization(session, runtime.sessions)),
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.forkScoped,
      );
      return yield* httpEffect;
    }).pipe(Effect.provide(RpcSerialization.layerJson)),
  );
  const base = yield* serve(routes).pipe(Effect.provideContext(runtime.context));
  const issue = Effect.fnUntraced(function* (allowed: boolean) {
    const issued = yield* runtime.sessions.issue({
      scopes: allowed ? ["orchestration:read"] : ["providers:manage"],
    });
    const session = yield* runtime.sessions.verify(issued.token, MAIN_LISTENER);
    const ticket = yield* runtime.auth.issueWebSocketTicket(session, { use: "rpc" });
    const query = new URLSearchParams({
      [ORCHESTRATION_PROTOCOL_QUERY_PARAM]: String(ORCHESTRATION_PROTOCOL_VERSION),
      wsTicket: Redacted.value(ticket.ticket),
    });
    return { url: base.replace(/^http/u, "ws") + "ws?" + query.toString(), id: issued.sessionId };
  });
  return { issue, revoke: runtime.sessions.revoke, reads: () => reads };
});

const target = { taskId: task.taskId, attentionRequest: "ask" };

it.effect(
  "the authenticated attention RPCs refuse a denied grant and stop serving a revoked socket",
  () =>
    Effect.gen(function* () {
      const server = yield* setup(false);
      const denied = yield* server.issue(false);
      const deniedClient = yield* connect(attentionRpcs, denied.url);
      expect(yield* Effect.flip(deniedClient[listBotAttention]({}))).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: "orchestration:read",
      });
      expect(yield* Effect.flip(deniedClient[getTask](target))).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: "orchestration:read",
      });
      expect(server.reads()).toBe(0);
      const allowed = yield* server.issue(true);
      const client = yield* connect(attentionRpcs, allowed.url);
      expect((yield* client[listBotAttention]({})).cursor).toBe(7);
      expect((yield* client[getTask](target)).answeredQuestions).toEqual([
        { questionId: "ask", inputId: "answer", answerText: "West" },
      ]);
      yield* server.revoke(allowed.id);
      expect(yield* Effect.flip(client[getTask](target))).toMatchObject({ _tag: "RpcClientError" });
      expect(yield* Effect.flip(client[listBotAttention]({}))).toMatchObject({
        _tag: "RpcClientError",
      });
      expect(server.reads()).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(Runtime.storage)),
);

it.effect("an older task-only client can read a task from a feed-capable server", () =>
  Effect.gen(function* () {
    const server = yield* setup(false);
    const issued = yield* server.issue(true);
    const legacy = yield* connect(oldRpcs, issued.url);
    expect(yield* legacy[getTask]({ taskId: task.taskId })).toEqual({
      ...task,
      answeredQuestions: [{ questionId: "ask", inputId: "answer" }],
    });
    expect(server.reads()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(Runtime.storage)),
);

it.effect("the new task reader works against an older server without a feed RPC", () =>
  Effect.gen(function* () {
    const server = yield* setup(true);
    const issued = yield* server.issue(true);
    const client = yield* connect(attentionRpcs, issued.url);
    expect(yield* client[getTask](target)).toEqual({
      ...task,
      answeredQuestions: [{ questionId: "ask", inputId: "answer" }],
    });
    expect(server.reads()).toBe(1);
    const unsupported = yield* Effect.exit(client[listBotAttention]({}));
    expect(unsupported._tag).toBe("Failure");
    expect(server.reads()).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(Runtime.storage)),
);

it.effect(
  "an authenticated owner cannot read answer text from another owner's persisted input",
  () =>
    Effect.gen(function* () {
      const server = yield* setup(false, "other-owner");
      const issued = yield* server.issue(true);
      const client = yield* connect(attentionRpcs, issued.url);
      expect((yield* client[getTask](target)).answeredQuestions).toEqual([
        { questionId: "ask", inputId: "answer" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Runtime.storage)),
);
