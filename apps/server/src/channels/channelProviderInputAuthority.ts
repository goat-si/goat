import { isGoatBotSessionThreadId, type MessageId, type OrchestrationV2Run } from "@goat/contracts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { MEMORY_GRANT_RANK } from "../memory/MemoryAccess.ts";
import { isUnlinkedPrincipal, lowerRuntimeMode } from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { sessionIntentFor } from "./channelBotSessionRuns.ts";
import { sessionMemoryCeiling } from "./channelDispatchAuthority.ts";
import { canReadChannelBotNotes } from "./slack/slackNoteAccess.ts";

export const CHANNEL_PERMISSION_CHANGED = "permission_changed";
export const CHANNEL_PERMISSION_CHANGED_MESSAGE =
  "The requester’s permission to start this work changed.";

const permissionChanged = makeProviderFailure({
  class: "permission_error",
  code: CHANNEL_PERMISSION_CHANGED,
  message: CHANNEL_PERMISSION_CHANGED_MESSAGE,
  retryable: false,
});

const makeProviderInputRefusal = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* ChannelLedger.ChannelLedger;
  return Effect.fn("ChannelBotSession.refuseProviderInput")(
    function* (
      threadId: OrchestrationV2Run["threadId"],
      messageId: MessageId,
      memoryGrantCeiling: OrchestrationV2Run["memoryGrantCeiling"],
    ) {
      if (!isGoatBotSessionThreadId(threadId)) return undefined;
      // The intent is written before dispatch and survives queueing and restart.
      const intent = yield* sessionIntentFor(sql, threadId, messageId);
      if (intent === undefined || intent.kind === "followup") return undefined;
      const stored = yield* ledger.getTask(intent.task_id);
      if (stored === undefined) return permissionChanged;
      const { task } = stored;
      const { requester, originAddress } = task;
      if (requester.originKind !== "slack" || originAddress.kind !== "slack") return undefined;
      if (task.generation !== intent.task_generation) return permissionChanged;
      // Workspace guests never receive a link grant for notes or a run memory ceiling.
      if (isUnlinkedPrincipal(requester.principalId)) return undefined;
      if (requester.externalActorId === undefined) return permissionChanged;
      const brief = yield* ledger.latestTaskBrief(task.taskId);
      const live = yield* ledger.findIdentity({
        connectionId: originAddress.connectionId,
        externalActorId: requester.externalActorId,
      });
      if (live?.ownerId !== requester.ownerId || live.principalId !== requester.principalId)
        return permissionChanged;
      const current = {
        ...requester,
        grantedScopes: requester.grantedScopes.filter((scope) =>
          live.grantedScopes.includes(scope),
        ),
      };
      const mode = task.target?.runtimeMode;
      return current.grantedScopes.includes("orchestration:operate") &&
        (mode === undefined || lowerRuntimeMode(mode, live.runtimeModeCeiling) === mode) &&
        (brief?.context.notesPath === undefined || canReadChannelBotNotes(current)) &&
        MEMORY_GRANT_RANK[sessionMemoryCeiling(current, task.target)] >=
          MEMORY_GRANT_RANK[memoryGrantCeiling ?? "none"]
        ? undefined
        : permissionChanged;
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
);
