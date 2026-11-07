import {
  WsRpcGroup as WsBaseRpcGroup,
  WsMemoryCoreRpcGroup,
  WsHubNodesRpcGroup,
  WsMemoryAdministrationRpcGroup,
  WsMemoryImportRpcGroup,
} from "@goat/contracts";
import { advanceQuiet } from "@goat/shared/stallAwareQuiet";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import { RpcClient } from "effect/rpc";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";

export const WsRpcGroup = WsBaseRpcGroup.merge(WsMemoryCoreRpcGroup)
  .merge(WsMemoryAdministrationRpcGroup)
  .merge(WsMemoryImportRpcGroup)
  .merge(WsHubNodesRpcGroup);

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

export const PING_TIMEOUT = "15 seconds";
const SOCKET_SILENCE_TIMEOUT = "300 seconds";

export const drainNodeIo = Effect.callback<void>((resume) => {
  const id = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(id));
});

export const makeWsRpcSocketProtocol = Effect.fnUntraced(function* (
  onTimeout: Effect.Effect<void>,
  slowTimeout: Duration.Duration = Duration.fromInputUnsafe(PING_TIMEOUT),
  drainIo: Effect.Effect<void> = drainNodeIo,
) {
  const socket = yield* Socket.Socket;
  const serialization = yield* RpcSerialization.RpcSerialization;
  const clock = yield* Clock.Clock;
  let generation = 0;
  const guardedSocket = {
    ...socket,
    reader: Effect.gen(function* () {
      const reader = yield* socket.reader;
      const expired = yield* Deferred.make<never, Socket.SocketError>();
      let state = {
        lastActivity: generation,
        lastTick: clock.monotonicTimeNanosUnsafe(),
        quiet: 0n,
      };
      let slow = false;
      yield* Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("5 seconds");
          yield* drainIo;
          state = advanceQuiet(state, clock.monotonicTimeNanosUnsafe(), generation, 5_000_000_000n);
          if (slow && state.quiet === 0n) {
            slow = false;
            yield* Effect.annotateCurrentSpan({ "connection.slow": false });
          }
          if (!slow && state.quiet >= Duration.toNanosUnsafe(slowTimeout)) {
            slow = true;
            yield* Effect.annotateCurrentSpan({ "connection.slow": true });
            yield* Effect.logInfo("WebSocket is slow to receive frames");
          }
          if (state.quiet >= Duration.toNanosUnsafe(SOCKET_SILENCE_TIMEOUT)) {
            yield* onTimeout;
            yield* Deferred.fail(
              expired,
              new Socket.SocketError({
                reason: new Socket.SocketReadError({ cause: new Error("ping timeout") }),
              }),
            );
            return;
          }
        }
      }).pipe(
        Effect.ensuring(Effect.annotateCurrentSpan({ "connection.slow": false })),
        Effect.withSpan("environment.websocket.silence"),
        Effect.forkScoped,
      );
      return { ...reader, pull: reader.pull.pipe(Effect.raceFirst(Deferred.await(expired))) };
    }),
  };
  const liveSerialization = {
    ...serialization,
    makeUnsafe: () => {
      const parser = serialization.makeUnsafe();
      return {
        ...parser,
        decode: (data: Uint8Array | string) => {
          generation += 1;
          return parser.decode(data);
        },
      };
    },
  };
  return yield* RpcClient.makeProtocolSocket({
    pingTimeout: Infinity,
    retryTransientErrors: false,
    retryPolicy: Schedule.recurs(0),
  }).pipe(
    Effect.provideService(Socket.Socket, guardedSocket),
    Effect.provideService(RpcSerialization.RpcSerialization, liveSerialization),
  );
});
