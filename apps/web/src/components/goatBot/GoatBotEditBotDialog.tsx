import { botManageFailure, replaceCreatedBot } from "@goat/client-runtime/goatBot";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotProfile } from "@goat/contracts";
import { modelSelectionsEqual } from "@goat/shared/model";
import { useState, type ComponentProps } from "react";

import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { GoatBotToolsField } from "./GoatBotToolsField";
import { GoatBotModelField } from "./GoatBotModelField";
import { GoatBotProfileDialog } from "./GoatBotProfileDialog";
import { useGoatBotMainName } from "./goatBotMemberContext";

/** Edits a bot's profile, and a member's model where its server takes one. */
export function GoatBotEditBotDialog({
  bot,
  canSubmit,
  onClose,
  draftName,
  finalFocus,
}: {
  readonly bot: BotProfile;
  readonly canSubmit: boolean;
  readonly onClose: () => void;
} & Pick<ComponentProps<typeof GoatBotProfileDialog>, "draftName" | "finalFocus">) {
  const update = useAtomCommand(channelEnvironment.updateBot, { reportFailure: false });
  const mainName = useGoatBotMainName();
  const presentation = useEnvironment(bot.environmentId);
  const modelEditable = useGoatBotMemberModelEditable(bot);
  const colorEditable = useGoatBotMemberColorEditable(bot);
  const [tools, setTools] = useState(bot.tools);
  const toolsEditable = presentation?.serverConfig?.environment.capabilities.goatBotTools === true;
  const toolsChanged = toolsEditable && JSON.stringify(tools) !== JSON.stringify(bot.tools);
  const [model, setModel] = useState(bot.defaultModelSelection);
  const modelChanged = modelEditable && !sameModel(model, bot.defaultModelSelection);
  return (
    <GoatBotProfileDialog
      initial={bot}
      draftName={draftName}
      finalFocus={finalFocus}
      canSubmit={canSubmit}
      extraChanged={modelChanged || toolsChanged}
      colorEditable={colorEditable}
      instructionsEditable={
        presentation?.serverConfig?.environment.capabilities.goatBotInstructions === true
      }
      onClose={onClose}
      onSubmit={async (changes) => {
        const result = await update({
          environmentId: bot.environmentId,
          input: {
            botId: bot.botId,
            ...changes,
            ...(toolsChanged && tools !== undefined ? { tools } : {}),
            ...(modelChanged ? { defaultModelSelection: model } : {}),
          },
        });
        if (result._tag === "Failure") return botManageFailure(squashAtomCommandFailure(result));
        replaceCreatedBot(bot.environmentId, result.value.bot);
        return null;
      }}
    >
      {toolsEditable ? (
        <GoatBotToolsField
          value={tools ?? { mcpServers: "all", skills: "all" }}
          onChange={setTools}
        />
      ) : null}
      {modelEditable ? (
        <GoatBotModelField
          environmentId={bot.environmentId}
          model={model}
          onChange={setModel}
          mainName={mainName}
          label={`${bot.name} model`}
        />
      ) : null}
    </GoatBotProfileDialog>
  );
}

/** A member's model can change only on a server that reads it; the main bot's is a setting. */
export function useGoatBotMemberModelEditable(bot: BotProfile): boolean {
  const presentation = useEnvironment(bot.environmentId);
  return (
    bot.role === "member" &&
    presentation?.serverConfig?.environment.capabilities.goatBotMemberModelEdit === true
  );
}

/** A member's color goes only to a server that stores one; older servers drop the key. */
function useGoatBotMemberColorEditable(bot: {
  readonly role: BotProfile["role"];
  readonly environmentId: BotProfile["environmentId"];
}): boolean {
  const presentation = useEnvironment(bot.environmentId);
  return (
    bot.role === "member" &&
    presentation?.serverConfig?.environment.capabilities.goatBotProfileColor === true
  );
}

function sameModel(
  left: BotProfile["defaultModelSelection"],
  right: BotProfile["defaultModelSelection"],
): boolean {
  return left === null || right === null ? left === right : modelSelectionsEqual(left, right);
}
