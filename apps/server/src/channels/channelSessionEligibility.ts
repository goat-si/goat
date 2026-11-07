// @effect-diagnostics-next-line nodeBuiltinImport:off -- session bindings are content hashes.
import * as NodeCrypto from "node:crypto";
import type { BotId, ChannelTask, ChannelDispatchTarget, ChannelRequester } from "@goat/contracts";
import { resolveGoatBotModelSelection } from "@goat/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import { requesterForDispatch } from "./channelDispatchAuthority.ts";
import { goatBotSessionSharingFor } from "./channelIds.ts";
const isLedgerError = Schema.is(ChannelLedger.ChannelLedgerError);

export const bindingKeyFor = (
  task: ChannelTask,
  target: Pick<ChannelDispatchTarget, "modelSelection" | "memoryGrantCeiling">,
  sharing: string,
  requester: ChannelRequester,
) => {
  const parts = [
    task.conversationId,
    requester.ownerId,
    requester.principalId,
    requester.externalActorId ?? "",
    requester.originKind,
    requester.runtimeModeCeiling,
    // A session's frozen journal shows what these scopes could see; another set starts a new one.
    requester.grantedScopes.toSorted().join(","),
    target.memoryGrantCeiling ?? "none",
    target.modelSelection.instanceId,
    target.modelSelection.model,
    sharing === "per_task" ? task.taskId : "",
  ];
  return NodeCrypto.createHash("sha256").update(parts.join("\u0000")).digest("base64url");
};

export const makeSessionEligibility = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const slackSettings = yield* SlackChannelSettings.SlackChannelSettings;
  const eligible = Effect.fn("ChannelBotSession.eligible")(
    function* (task: ChannelTask, botId: BotId) {
      const requester = yield* requesterForDispatch(task).pipe(
        Effect.provideService(ChannelLedger.ChannelLedger, ledger),
        Effect.provideService(SlackChannelSettings.SlackChannelSettings, slackSettings),
      );
      if (requester === undefined || requester.originKind === "mcp") return false;
      const settings = yield* serverSettings.getSettings;
      let selection = resolveGoatBotModelSelection(settings);
      const instance = yield* providers.getInstance(selection.instanceId);
      const snapshot = instance === undefined ? undefined : yield* instance.snapshot.getSnapshot;
      if (
        snapshot === undefined ||
        (snapshot.models.length > 0 &&
          !snapshot.models.some((model) => model.slug === selection.model))
      ) {
        selection = resolveGoatBotModelSelection({ ...settings, goatBotModelSelection: null });
      }
      const bound = yield* providers.getInstance(selection.instanceId);
      if (goatBotSessionSharingFor(bound?.driverKind) !== "per_run") return false;
      const bot = yield* ledger.getBotById(requester.ownerId, botId);
      if (bot === undefined) return false;
      return (yield* projects.listShells()).some((project) => project.id === bot.bot.projectId);
    },
    Effect.mapError((cause) =>
      isLedgerError(cause)
        ? cause
        : new ChannelLedger.ChannelLedgerError({
            reason: "persistence",
            detail: "session eligibility",
            cause,
          }),
    ),
  );

  return eligible;
});
