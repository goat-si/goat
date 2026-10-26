import {
  WsRpcGroup as WsBaseRpcGroup,
  WsMemoryCoreRpcGroup,
  WsHubNodesRpcGroup,
  WsMemoryAdministrationRpcGroup,
  WsMemoryImportRpcGroup,
} from "@goat/contracts";
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

// Pings go out every 5 seconds, and a server busy for a few seconds stops
// answering them. Allow 15 seconds without any frame before dropping the socket.
export const PING_TIMEOUT = "15 seconds";

// The upstream pinger treats a frozen event loop as silence when a ping is
// outstanding. Keep its ping sender, but own the deadline at the socket boundary
// so one late timer per received frame grants the resumed reader a full budget.
export const makeWsRpcSocketProtocol = Effect.fnUntraced(function* (
  onTimeout: Effect.Effect<void>,
  silenceTimeout: Duration.Duration = Duration.fromInputUnsafe(PING_TIMEOUT),
) {
  const socket = yield* Socket.Socket;
  const serialization = yield* RpcSerialization.RpcSerialization;
  const clock = yield* Clock.Clock;
  let lastFrame = clock.currentTimeMillisUnsafe();
  let freezeGraceUsed = false;
  const guardedSocket = {
    ...socket,
    reader: Effect.gen(function* () {
      const reader = yield* socket.reader;
      const expired = yield* Deferred.make<never, Socket.SocketError>();
      lastFrame = clock.currentTimeMillisUnsafe();
      freezeGraceUsed = false;
      yield* Effect.gen(function* () {
        while (true) {
          const deadline = clock.currentTimeMillisUnsafe() + 5_000;
          yield* clock.sleep(Duration.millis(5_000));
          const now = clock.currentTimeMillisUnsafe();
          if (now - deadline > 2_000 && !freezeGraceUsed) {
            lastFrame = now;
            freezeGraceUsed = true;
          } else if (now - lastFrame > Duration.toMillis(silenceTimeout)) {
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
      }).pipe(Effect.forkScoped);
      return {
        ...reader,
        pull: reader.pull.pipe(Effect.raceFirst(Deferred.await(expired))),
      };
    }),
  };
  const liveSerialization = {
    ...serialization,
    makeUnsafe: () => {
      const parser = serialization.makeUnsafe();
      return {
        ...parser,
        decode: (data: Uint8Array | string) => {
          const frames = parser.decode(data);
          if (frames.length > 0) {
            lastFrame = clock.currentTimeMillisUnsafe();
            freezeGraceUsed = false;
          }
          return frames;
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
