import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as AcpClient from "./client.ts";
import * as AcpSchemaV1 from "./_generated/schema-v1.gen.ts";
import { expectedNoticeUpdates, noticeUpdates } from "./notice.testkit.ts";
import {
  encodeJsonl,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
} from "./_internal/shared.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const InitializeRequestV1 = jsonRpcRequest("initialize", AcpSchemaV1.InitializeRequest);
const SessionUpdateNotification = jsonRpcNotification("session/update", Schema.Unknown);

it.layer(NodeServices.layer)("ACP notices and tool updates", (it) => {
  it.effect.each([1, 2])("validates session notices with ACP version %s", (protocolVersion) =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const scope = yield* Scope.make();
      const acp = yield* AcpClient.make(stdio).pipe(Effect.provideService(Scope.Scope, scope));
      const initializeFiber = yield* acp.agent
        .initialize({ protocolVersion, clientCapabilities: { session: { notices: {} } } })
        .pipe(Effect.forkScoped);
      const initializeRequest = yield* Queue.take(output).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(InitializeRequestV1))),
      );
      yield* Queue.offer(
        input,
        yield* encodeJsonl(jsonRpcResponse(Schema.Unknown), {
          jsonrpc: "2.0",
          id: initializeRequest.id,
          result: {
            protocolVersion,
            ...(protocolVersion === 2 ? { info: { name: "notice-agent", version: "0.0.0" } } : {}),
          },
        }),
      );
      yield* Fiber.join(initializeFiber);

      const toolUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "c",
        status: "completed",
      } as const;
      for (const update of [...noticeUpdates, { ...toolUpdate, name: null }]) {
        yield* Queue.offer(
          input,
          yield* encodeJsonl(SessionUpdateNotification, {
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: "session-1", update },
          }),
        );
      }
      const received = yield* acp.raw.notifications.pipe(
        Stream.take(noticeUpdates.length + 1),
        Stream.runCollect,
      );
      assert.deepEqual(
        Array.from(received, (event) =>
          event._tag === "SessionUpdate" ? event.params.update : undefined,
        ),
        [
          ...expectedNoticeUpdates,
          protocolVersion === 1 ? toolUpdate : { ...toolUpdate, name: null },
        ],
      );
      yield* Scope.close(scope, Exit.void);
    }),
  );
});
