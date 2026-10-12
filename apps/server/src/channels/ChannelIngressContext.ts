/**
 * ChannelIngressContext - who is behind a channel call, as the server authenticated it.
 *
 * Transports build this from their own authentication (an RPC session, an MCP invocation, a
 * Slack connection) and pass it next to the wire input. It never comes from the wire: a caller
 * cannot choose its own owner, scopes, or runtime ceiling.
 *
 * @module ChannelIngressContext
 */
import type {
  AuthEnvironmentScope,
  ChannelKind,
  CommandId,
  RuntimeMode,
  ThreadId,
} from "@goat/contracts";

export type ChannelIngressCaller =
  | { readonly type: "rpc"; readonly clientId?: string }
  | {
      readonly type: "mcp";
      readonly requestNamespace: string;
      readonly callerThreadId?: ThreadId;
    }
  | { readonly type: "transport"; readonly kind: ChannelKind; readonly connectionId: string }
  /** A legacy `message.dispatch` to the GOAT bot, redirected by thread message intake. */
  | { readonly type: "intake"; readonly commandId: CommandId };

/**
 * The host owner a connection acts for, with the scopes and runtime ceiling allowed to that
 * connection. A Slack connection stores the owner who configured it; each event's context is
 * that owner plus the transport caller.
 */
export interface ChannelConnectionOwner {
  readonly ownerId: string;
  readonly principalId: string;
  readonly displayName: string;
  readonly grantedScopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly runtimeModeCeiling: RuntimeMode;
}

export interface ChannelIngressContext extends ChannelConnectionOwner {
  readonly caller: ChannelIngressCaller;
}
