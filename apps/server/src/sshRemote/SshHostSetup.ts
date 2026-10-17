import {
  AuthEnvironmentMaintainScope,
  EnvironmentAuthorizationError,
  type AuthSessionId,
  type SshHostResult,
  type SshHostStatusInput,
  type SshRuntimeUpdateInput,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";

export type SshHostCaller =
  | { readonly kind: "client"; readonly sessionId: AuthSessionId }
  | { readonly kind: "mcp"; readonly scope: McpInvocationScope };

export class SshHostSetup extends Context.Service<
  SshHostSetup,
  {
    readonly status: (input: SshHostStatusInput) => Effect.Effect<SshHostResult>;
    readonly update: (
      input: SshRuntimeUpdateInput,
      caller: SshHostCaller,
    ) => Effect.Effect<SshHostResult, EnvironmentAuthorizationError>;
  }
>()("goat/sshRemote/SshHostSetup") {}

const dispatchFailure = (error: SshRemoteDispatch.SshRemoteDispatchError): SshHostResult => ({
  kind: "error",
  code:
    error.reason === "host_unknown" || error.reason === "invalid_request"
      ? error.reason
      : error.reason === "host_unavailable"
        ? "host_unreachable"
        : "operation_failed",
  message: Array.from(error.message).slice(0, 2000).join(""),
  fix: { actor: "agent", instruction: "Try again" },
});

const desktopUpdateInstruction =
  "Choose Update now in Settings → Connections on the desktop app that owns this connection.";

const make = Effect.gen(function* () {
  const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
  const status = Effect.fn("SshHostSetup.status")(function* (input: SshHostStatusInput) {
    return yield* dispatch.runtimeStatus(input.host).pipe(
      Effect.catchTags({
        SshRemoteDispatchError: (error) => Effect.succeed(dispatchFailure(error)),
      }),
    );
  });
  const update = Effect.fn("SshHostSetup.update")(function* (
    input: SshRuntimeUpdateInput,
    caller: SshHostCaller,
  ) {
    // Server client updates await the alias RPC/approval workflow. Desktop owns its IPC path.
    if (caller.kind === "client") {
      return {
        kind: "error",
        code: "unsupported",
        message: `Server client SSH runtime updates are not supported. ${desktopUpdateInstruction}`,
        fix: { actor: "human", instruction: desktopUpdateInstruction },
      } satisfies SshHostResult;
    }
    const scope = caller.scope;
    if (
      scope.readOnly ||
      scope.client?.access === "read-only" ||
      !scope.capabilities.has("orchestration") ||
      !scope.grantedScopes?.includes(AuthEnvironmentMaintainScope) ||
      scope.reauthorize === undefined
    ) {
      return yield* new EnvironmentAuthorizationError({
        requiredScope: AuthEnvironmentMaintainScope,
        message: "Updating an SSH runtime needs a live environment:maintain grant.",
      });
    }
    yield* scope.reauthorize([AuthEnvironmentMaintainScope]);
    if ((input.mode ?? "when_idle") === "now") {
      return {
        kind: "error",
        code: "unsupported",
        message: `${desktopUpdateInstruction} For an agent update, call again with mode when_idle.`,
        fix: { actor: "human", instruction: desktopUpdateInstruction },
      } satisfies SshHostResult;
    }
    return yield* dispatch.runtimeUpdate(input.host, { confirmReplacement: false }).pipe(
      Effect.catchTags({
        SshRemoteDispatchError: (error) => Effect.succeed(dispatchFailure(error)),
      }),
    );
  });
  return SshHostSetup.of({ status, update });
});

export const layer = Layer.effect(SshHostSetup, make);
