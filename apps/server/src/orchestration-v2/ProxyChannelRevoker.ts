import type { ThreadId } from "@goat/contracts";
import type * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";

import * as ComputerUse from "../cua/ComputerUseAttachment.ts";
import * as ComputerUsePrimitiveChannel from "../cua/ComputerUsePrimitiveChannel.ts";

/** Revokes a thread's screen proxy channel; test assemblies without the channel skip it. */
export const proxyChannelRevoker = (sessions: McpProviderSessions.McpProviderSessions["Service"]) =>
  Effect.serviceOption(ComputerUsePrimitiveChannel.ComputerUsePrimitiveChannel).pipe(
    Effect.map(
      (channel) => (threadId: ThreadId, expectedCredentialId?: string) =>
        ComputerUse.revokeProxyChannelAttachment(channel, sessions, threadId, expectedCredentialId),
    ),
  );
