import type { ForwardedPermissionProfile } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { stableCommandId } from "./stableCommandId.ts";

export interface RemoteSendAdmissionInput {
  readonly host: string;
  readonly threadId: string;
  readonly clientRequestId?: string | undefined;
  readonly forwarded?: ForwardedPermissionProfile | undefined;
}

export const makeRemoteSendAdmission = (
  permissions: Profiles.PermissionProfiles["Service"],
  requestKey: (clientRequestId: string | undefined) => Effect.Effect<string>,
) =>
  Effect.fn("OrchestratorMcpService.admitRemoteSend")(function* (
    scope: McpInvocationScope,
    input: RemoteSendAdmissionInput,
  ) {
    const effective = yield* permissions.resolve(scope, undefined, input.forwarded);
    if (!effective.enabled) return { ceiling: undefined, settle: () => Effect.void };
    const context = {
      host: input.host,
      runtimeMode: effective.runtimeMode,
      forwarded: input.forwarded,
    };
    yield* permissions.require(scope, "threads.launch", context);
    yield* permissions.require(scope, "threads.remote", context);
    const id = stableCommandId({
      scope,
      requestKey: yield* requestKey(input.clientRequestId),
      operation: `remote-send:${input.host}:${input.threadId}`,
    });
    const admitted = yield* permissions.claim(scope, {
      id,
      host: input.host,
      runtimeMode: effective.runtimeMode,
      remoteThreadId: input.threadId,
      forwarded: input.forwarded,
    });
    return {
      ceiling: Profiles.remoteSendCeiling(effective, admitted),
      settle: (sent: boolean) =>
        sent ? permissions.completeRemote(id, input.host, input.threadId) : permissions.release(id),
    };
  });

export type RemoteSendAdmission = ReturnType<typeof makeRemoteSendAdmission>;
