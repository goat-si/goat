import { DesktopPenPinSchema, DesktopPenRouteResultSchema } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Gateway from "../../pen/PenGateway.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

export const openPenRoute = DesktopIpc.makeIpcMethod({
  channel: Channels.OPEN_PEN_ROUTE_CHANNEL,
  payload: DesktopPenPinSchema,
  result: DesktopPenRouteResultSchema,
  handler: Effect.fn("desktop.ipc.penRoute.open")(function* (pin) {
    const gateway = yield* Gateway.PenGateway;
    return yield* Effect.promise(() => gateway.open(pin));
  }),
});

export const closePenRoute = DesktopIpc.makeIpcMethod({
  channel: Channels.CLOSE_PEN_ROUTE_CHANNEL,
  payload: DesktopPenPinSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.penRoute.close")(function* (pin) {
    const gateway = yield* Gateway.PenGateway;
    yield* Effect.promise(() => gateway.close(pin));
  }),
});
