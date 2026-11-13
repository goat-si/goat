import { DesktopPenPinSchema, DesktopPenRevokeResultSchema } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as PenRevoke from "../../pen/PenRevoke.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

export const revokePenMember = DesktopIpc.makeIpcMethod({
  channel: Channels.REVOKE_PEN_MEMBER_CHANNEL,
  payload: DesktopPenPinSchema,
  result: DesktopPenRevokeResultSchema,
  handler: Effect.fn("desktop.ipc.penRevoke")(function* (pin) {
    const revoke = yield* PenRevoke.PenRevoke;
    return yield* revoke.revoke(pin);
  }),
});
