import { useAtomValue } from "@effect/atom-react";
import { botManageFailure } from "@goat/client-runtime/goatBot";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotProfile } from "@goat/contracts";
import { createModelSelection } from "@goat/shared/model";
import { Atom } from "effect/reactivity";

import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { toastManager } from "../ui/toast";
import { useGoatBotMemberModelEditable } from "./GoatBotEditBotDialog";
import { useGoatBotMainName } from "./goatBotMemberContext";
import { useGoatBotModel } from "./useGoatBotModel";

const NO_PERMISSION = Atom.make(false);

/** The model a member's next turn uses, switchable from its header where the server takes it. */
export function GoatBotMemberModelPicker({ member }: { readonly member: BotProfile }) {
  const { selection, entries, options } = useGoatBotModel(member.environmentId);
  const mainName = useGoatBotMainName();
  const editable = useGoatBotMemberModelEditable(member);
  const canEdit = useAtomValue(
    editable ? channelEnvironment.updateBot.permissionAtom(member.environmentId) : NO_PERMISSION,
  );
  const update = useAtomCommand(channelEnvironment.updateBot, { reportFailure: false });
  const shown = member.defaultModelSelection ?? selection;
  const modelName =
    entries
      .find((entry) => entry.instanceId === shown.instanceId)
      ?.models.find((entry) => entry.slug === shown.model)?.name ?? shown.model;
  return (
    <ProviderModelPicker
      environmentId={member.environmentId}
      activeInstanceId={shown.instanceId}
      model={shown.model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={options}
      popupAlign="end"
      triggerAriaLabel={`${member.name} model: ${modelName}${
        member.defaultModelSelection === null ? ` (same as ${mainName})` : ""
      }`}
      disabled={!canEdit}
      onInstanceModelChange={(instanceId, model) => {
        void update({
          environmentId: member.environmentId,
          input: {
            botId: member.botId,
            defaultModelSelection: createModelSelection(instanceId, model),
          },
        }).then((result) => {
          if (result._tag === "Failure")
            toastManager.add({
              type: "error",
              title: `Couldn't change ${member.name}'s model`,
              description: botManageFailure(squashAtomCommandFailure(result)),
            });
        });
      }}
    />
  );
}
