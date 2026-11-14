import {
  DesktopPenMemberSessionInputSchema,
  DesktopPenMemberSessionResultSchema,
  DesktopPenMembersState,
} from "@goat/contracts";
import { SshInvalidTargetError } from "@goat/ssh/errors";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopPenMembers from "../../pen/DesktopPenMembers.ts";
import * as DesktopSshEnvironment from "../../ssh/DesktopSshEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getPenMembers = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_PEN_MEMBERS_CHANNEL,
  payload: Schema.Void,
  result: DesktopPenMembersState,
  handler: Effect.fn("desktop.ipc.penMembers.get")(function* () {
    return yield* (yield* DesktopPenMembers.DesktopPenMembers).state;
  }),
});

export const issuePenMemberSession = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ISSUE_PEN_MEMBER_SESSION_CHANNEL,
  payload: DesktopPenMemberSessionInputSchema,
  result: DesktopPenMemberSessionResultSchema,
  handler: Effect.fn("desktop.ipc.penMembers.issueSession")(function* ({ target, penNodeId }) {
    const members = yield* DesktopPenMembers.DesktopPenMembers;
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    const self = yield* members.requireTrusted(target, penNodeId, { requireReady: true });
    if (self === undefined)
      return yield* new SshInvalidTargetError({
        message: "Pen's member list cannot be confirmed right now.",
      });
    const session = yield* sshEnvironment.issuePenMemberSession(target, self);
    // The token leaves main only for a machine that is still a member once it exists.
    yield* members.requireTrusted(target, penNodeId, { requireReady: true });
    return { accessToken: session.token, expiresAt: session.expiresAt, scopes: session.scopes };
  }),
});
