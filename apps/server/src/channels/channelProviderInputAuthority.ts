import {
  isGoatBotSessionThreadId,
  type ChannelInputId,
  type ChannelRequester,
  type MessageId,
  type OrchestrationV2Run,
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
import { canReadChannelBotNotes } from "./channelBotNoteAccess.ts";
import { sessionIntentFor } from "./channelBotSessionRuns.ts";
import {
  currentRequester as currentAppRequester,
  narrowRequester,
  requesterForDispatch,
  sessionMemoryCeiling,
} from "./channelDispatchAuthority.ts";
import { isChannelWorkerThreadId } from "./channelIds.ts";
import { sessionCarriesNotes, workerBriefOwner } from "./channelProviderBrief.ts";
import { sessionForwardEventFor } from "./channelSessionForwardEvent.ts";
import { makeReadSlackWorkspaceIdentity } from "./slack/slackChannelSettingsFile.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";

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
  const workspaceIdentity = yield* makeReadSlackWorkspaceIdentity;
  const slackSettings = yield* SlackChannelSettings.SlackChannelSettings;
  const currentRequester = Effect.fn("ChannelBotSession.currentProviderInputRequester")(function* (
    requester: ChannelRequester,
    connectionId: string | undefined,
    inputId?: ChannelInputId,
  ) {
    if (requester.originKind !== "slack" && requester.originKind !== "imessage")
      return yield* currentAppRequester(requester, connectionId, inputId).pipe(
        Effect.provideService(ChannelLedger.ChannelLedger, ledger),
        Effect.provideService(SlackChannelSettings.SlackChannelSettings, slackSettings),
      );
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
      const session = isGoatBotSessionThreadId(threadId);
      if (!session && !isChannelWorkerThreadId(threadId)) return undefined;
      const intent = session ? yield* sessionIntentFor(sql, threadId, messageId) : undefined;
      const worker = session ? undefined : yield* workerBriefOwner(sql, threadId, messageId);
      const taskId = intent?.task_id ?? worker?.task_id;
      if (taskId === undefined) return undefined;
      const stored = yield* ledger.getTask(taskId);
      if (
        stored === undefined ||
        stored.task.generation !== (intent?.task_generation ?? worker?.generation)
      )
        return permissionChanged;

      const { task } = stored;
      const { requester, originAddress } = task;
      const slackSession =
        session && requester.originKind === "slack" && originAddress.kind === "slack";
      const brief = yield* ledger.latestTaskBrief(taskId);
      const carriesNotes =
        brief?.context.notesPath !== undefined ||
        (session && (yield* sessionCarriesNotes(sql, threadId)));
      if (
        !slackSession &&
        !carriesNotes &&
        (memoryGrantCeiling ?? "none") === "none" &&
        isUnlinkedPrincipal(requester.principalId)
      )
        return undefined;

      const current =
        slackSession && task.routineWork !== true
          ? yield* currentRequester(requester, originAddress.connectionId, task.originInputId)
          : yield* requesterForDispatch(task);
      const mode = task.target?.runtimeMode;
      if (
        current === undefined ||
        !current.grantedScopes.includes("orchestration:operate") ||
        (mode !== undefined && lowerRuntimeMode(mode, current.runtimeModeCeiling) !== mode) ||
        MEMORY_GRANT_RANK[sessionMemoryCeiling(current, task.target)] <
          MEMORY_GRANT_RANK[memoryGrantCeiling ?? "none"] ||
        (carriesNotes && !canReadChannelBotNotes(current))
      )
        return permissionChanged;

      if (intent?.kind === "followup" && (slackSession || carriesNotes)) {
        const forward = yield* sessionForwardEventFor(sql, threadId, messageId, task);
        if (forward === undefined) return permissionChanged;
        const { sender, inputId: originalInputId } = forward.payload;
        if (sender === undefined && forward.actor !== "user")
          return carriesNotes ? permissionChanged : undefined;
        const inputId = sender?.inputId ?? originalInputId;
        const input =
          sender === undefined && inputId !== undefined
            ? yield* ledger.getInput(inputId)
            : undefined;
        const snapshot = sender?.requester ?? input?.requester;
        if (snapshot === undefined) return permissionChanged;
        if (carriesNotes && snapshot.originKind === "goat" && inputId === undefined)
          return permissionChanged;
        const connectionId = sender?.connectionId ?? input?.message.connectionId;
        const live = yield* currentRequester(snapshot, connectionId, inputId);
        if (
          live === undefined ||
          !mayDirect(live, connectionId, { ...task, requester: current }) ||
          (carriesNotes && !canReadChannelBotNotes(live))
        )
          return permissionChanged;
      }
      return undefined;
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.provideService(ChannelLedger.ChannelLedger, ledger),
        Effect.provideService(SlackChannelSettings.SlackChannelSettings, slackSettings),
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
  Layer.provide(SlackChannelSettings.layerUnavailable),
);
