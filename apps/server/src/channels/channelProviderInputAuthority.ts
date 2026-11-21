import {
  isGoatBotSessionThreadId,
  type ChannelRequester,
  type MessageId,
  type OrchestrationV2Run,
  type RuntimeMode,
} from "@goat/contracts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { MEMORY_GRANT_RANK } from "../memory/MemoryAccess.ts";
import { isUnlinkedPrincipal, lowerRuntimeMode, mayDirect } from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelWake from "./ChannelWake.ts";
import { sessionIntentFor } from "./channelBotSessionRuns.ts";
import { narrowRequester, sessionMemoryCeiling } from "./channelDispatchAuthority.ts";
import { sessionForwardEventFor } from "./channelSessionForwardEvent.ts";
import { makeReadSlackWorkspaceIdentity } from "./slack/slackChannelSettingsFile.ts";
import { canReadChannelBotNotes } from "./slack/slackNoteAccess.ts";

export const CHANNEL_PERMISSION_CHANGED = "permission_changed";
export const CHANNEL_PERMISSION_CHANGED_MESSAGE =
  "The requester’s permission to start this work changed.";

export class ProviderInputRuntimeMode extends Context.Service<
  ProviderInputRuntimeMode,
  RuntimeMode
>()("goat/channels/channelProviderInputAuthority/ProviderInputRuntimeMode") {}

const permissionChanged = makeProviderFailure({
  class: "permission_error",
  code: CHANNEL_PERMISSION_CHANGED,
  message: CHANNEL_PERMISSION_CHANGED_MESSAGE,
  retryable: false,
});

const makeProviderInputRefusal = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* ChannelLedger.ChannelLedger;
  const workspaceIdentity = yield* makeReadSlackWorkspaceIdentity;
  const currentRequester = Effect.fn("ChannelBotSession.currentProviderInputRequester")(function* (
    requester: ChannelRequester,
    connectionId: string | undefined,
  ) {
    if (requester.originKind !== "slack" && requester.originKind !== "imessage") return requester;
    const externalActorId = requester.externalActorId;
    if (externalActorId === undefined || connectionId === undefined) return undefined;
    const linked = yield* ledger.findIdentity({ connectionId, externalActorId });
    const live =
      linked ??
      (requester.originKind === "slack" && isUnlinkedPrincipal(requester.principalId)
        ? yield* workspaceIdentity(connectionId, externalActorId)
        : undefined);
    return narrowRequester(requester, live);
  });
  return Effect.fn("ChannelBotSession.refuseProviderInput")(
    function* (
      threadId: OrchestrationV2Run["threadId"],
      messageId: MessageId,
      memoryGrantCeiling: OrchestrationV2Run["memoryGrantCeiling"],
    ) {
      if (!isGoatBotSessionThreadId(threadId)) return undefined;
      // The intent is written before dispatch and survives queueing and restart.
      const intent = yield* sessionIntentFor(sql, threadId, messageId);
      if (intent === undefined) return undefined;
      const stored = yield* ledger.getTask(intent.task_id);
      if (stored === undefined) return permissionChanged;
      const { task } = stored;
      const { requester, originAddress } = task;
      if (requester.originKind !== "slack" || originAddress.kind !== "slack") return undefined;
      if (task.generation !== intent.task_generation) return permissionChanged;
      const current = yield* currentRequester(requester, originAddress.connectionId);
      const mode = yield* ProviderInputRuntimeMode;
      if (
        current === undefined ||
        !current.grantedScopes.includes("orchestration:operate") ||
        lowerRuntimeMode(mode, current.runtimeModeCeiling) !== mode ||
        MEMORY_GRANT_RANK[sessionMemoryCeiling(current, task.target)] <
          MEMORY_GRANT_RANK[memoryGrantCeiling ?? "none"]
      )
        return permissionChanged;
      const brief = yield* ledger.latestTaskBrief(task.taskId);
      if (brief?.context.notesPath !== undefined && !canReadChannelBotNotes(current))
        return permissionChanged;

      if (intent.kind === "followup") {
        const forward = yield* sessionForwardEventFor(sql, threadId, messageId, task);
        if (forward === undefined) return permissionChanged;
        const { sender, inputId } = forward.payload;
        if (sender === undefined && forward.actor !== "user") return undefined;
        const input =
          sender === undefined && inputId !== undefined
            ? yield* ledger.getInput(inputId)
            : undefined;
        const snapshot = sender?.requester ?? input?.requester;
        if (snapshot === undefined) return permissionChanged;
        const connectionId = sender?.connectionId ?? input?.message.connectionId;
        const live = yield* currentRequester(snapshot, connectionId);
        if (
          live === undefined ||
          lowerRuntimeMode(mode, live.runtimeModeCeiling) !== mode ||
          !mayDirect(live, connectionId, { ...task, requester: current })
        )
          return permissionChanged;
      }
      return undefined;
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Could not verify the channel provider input grant", {
            threadId,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => permissionChanged),
      ),
  );
});

export class ChannelProviderInputAuthority extends Context.Service<
  ChannelProviderInputAuthority,
  Effect.Success<typeof makeProviderInputRefusal>
>()("goat/channels/channelProviderInputAuthority") {}

export const layer = Layer.effect(ChannelProviderInputAuthority, makeProviderInputRefusal).pipe(
  Layer.provide(ChannelLedger.layer),
  Layer.provide(ChannelWake.layer),
);
