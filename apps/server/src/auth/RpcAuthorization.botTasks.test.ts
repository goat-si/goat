import { describe, expect, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, WsChannelRpcGroup as WsRpcGroup } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("bot task RPC authorization", () => {
  it.effect("enforces read scope at the bot task RPC middleware boundary", () =>
    Effect.gen(function* () {
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<
            RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"],
            "channel.getBotTask" | "channel.searchBotTasks"
          > => tag !== "channel.getBotTask" && tag !== "channel.searchBotTasks",
        ),
      );
      let calls = 0;
      const handlers = Layer.mergeAll(
        group.toLayerHandler("channel.getBotTask", () =>
          Effect.sync(() => {
            calls++;
            return {
              task: {
                state: "unavailable" as const,
                task: {
                  taskId: "task" as never,
                  title: "Task",
                  status: "running" as const,
                  updatedAt: "2026-11-14",
                },
              },
              codingRows: [],
              remoteWork: [],
              launchesTruncated: false,
              partial: true,
            };
          }),
        ),
        group.toLayerHandler("channel.searchBotTasks", () =>
          Effect.sync(() => {
            calls++;
            return { tasks: [] };
          }),
        ),
      );
      const denied = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.mergeAll(handlers, RpcAuthorization.layer([]))),
      );
      const lookup = { taskId: "task" as never, botId: "main" as never };
      const search = { botId: "main" as never, query: "task" };
      expect(yield* denied["channel.getBotTask"](lookup).pipe(Effect.flip)).toMatchObject({
        requiredPermission: AuthOrchestrationReadScope,
      });
      expect(yield* denied["channel.searchBotTasks"](search).pipe(Effect.flip)).toMatchObject({
        requiredPermission: AuthOrchestrationReadScope,
      });
      expect(calls).toBe(0);
      const allowed = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(handlers, RpcAuthorization.layer([AuthOrchestrationReadScope])),
        ),
      );
      yield* allowed["channel.getBotTask"](lookup);
      yield* allowed["channel.searchBotTasks"](search);
      expect(calls).toBe(2);
    }).pipe(Effect.scoped),
  );
});
