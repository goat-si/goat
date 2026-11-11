import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadForkError,
  ThreadId,
  WsOrchestrationV2ForkThreadRpc,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import { ServerRuntimeStartupError } from "../../serverRuntimeStartup.ts";
import { threadForkRpcHandlers } from "./ThreadForkRpc.ts";
import { ThreadForkWorkspaceService } from "./ThreadForkWorkspace.ts";

const group = RpcGroup.make(WsOrchestrationV2ForkThreadRpc);
const input = {
  commandId: CommandId.make("rpc-fork"),
  sourceThreadId: ThreadId.make("rpc-fork-source"),
  targetThreadId: ThreadId.make("rpc-fork-target"),
  sourcePoint: { type: "latest_stable" as const },
  workspace: { type: "worktree" as const },
};
const refusal = new OrchestrationV2ThreadForkError({
  commandId: input.commandId,
  sourceThreadId: input.sourceThreadId,
  reason: "uncommitted_unsupported",
  message: "The uncommitted changes could not be copied.",
});
const forks = Layer.mock(ThreadForkWorkspaceService)({ fork: () => Effect.fail(refusal) });

const callFork = (startup: Parameters<typeof threadForkRpcHandlers>[0]) =>
  Effect.gen(function* () {
    const handlers = yield* threadForkRpcHandlers(startup);
    const client = yield* RpcTest.makeClient(group).pipe(Effect.provide(group.toLayer(handlers)));
    return yield* client[ORCHESTRATION_V2_WS_METHODS.forkThread](input).pipe(Effect.flip);
  }).pipe(Effect.scoped, Effect.provide(forks));

it.effect("a refused fork reaches the client as a decodable fork error with its reason", () =>
  Effect.gen(function* () {
    const error = yield* callFork({ enqueueCommand: (work) => work });
    assert.equal(error._tag, "OrchestrationV2ThreadForkError");
    if (error._tag !== "OrchestrationV2ThreadForkError") return;
    assert.equal(error.reason, "uncommitted_unsupported");

    // What the WebSocket carries: the RPC's declared error union, encoded to JSON and back.
    const codec = Schema.toCodecJson(WsOrchestrationV2ForkThreadRpc.errorSchema);
    const decoded = Schema.decodeUnknownSync(codec)(
      JSON.parse(JSON.stringify(Schema.encodeUnknownSync(codec)(error))),
    );
    assert.equal(decoded._tag, "OrchestrationV2ThreadForkError");
    if (decoded._tag !== "OrchestrationV2ThreadForkError") return;
    assert.equal(decoded.reason, "uncommitted_unsupported");
  }),
);

it.effect("a server that is still starting refuses the fork within the fork error union", () =>
  Effect.gen(function* () {
    const error = yield* callFork({
      enqueueCommand: () =>
        Effect.fail(
          new ServerRuntimeStartupError({ mode: "web", host: null, port: 0, cause: "not ready" }),
        ),
    });
    assert.equal(error._tag, "OrchestrationV2ThreadForkError");
    if (error._tag !== "OrchestrationV2ThreadForkError") return;
    assert.equal(error.reason, "fork_failed");
  }),
);
it.effect(
  "the server refuses forking a thread, into a worktree or not, to a read-only session",
  () =>
    Effect.gen(function* () {
      const method = ORCHESTRATION_V2_WS_METHODS.forkThread;
      for (const scopes of [[], [AuthOrchestrationReadScope]]) {
        const denied = yield* Effect.flip(RpcAuthorization.authorizeRpcCall(scopes, method, input));
        assert.equal(denied.requiredPermission, AuthOrchestrationOperateScope);
      }
      yield* RpcAuthorization.authorizeRpcCall([AuthOrchestrationOperateScope], method, input);
    }),
);
