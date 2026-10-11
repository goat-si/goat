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
} from "@t3tools/contracts";

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

export interface ChannelIngressContext {
  readonly ownerId: string;
  readonly principalId: string;
  readonly displayName: string;
  readonly grantedScopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly runtimeModeCeiling: RuntimeMode;
  readonly caller: ChannelIngressCaller;
}
