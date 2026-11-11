import type { BotProfile, EnvironmentId } from "@goat/contracts";
import { useState } from "react";

import { MobileBotProfileSheet } from "./MobileBotProfileSheet";
import { MobileNewBotModel } from "./MobileNewBotModel";
import type { useMobileBotManage } from "./useMobileBotManage";
import {
  useMobileGoatBotColorEditable,
  useMobileGoatBotMemberModelEditable,
} from "./useMobileGoatBotMemberModel";

/**
 * Edit bot: name, look, purpose, a member's colour and model. `draftName` starts the name field
 * from words typed elsewhere (the chat's name row) while changes still count against the bot.
 */
export function MobileBotEditSheet(props: {
  readonly bot: BotProfile;
  readonly environmentId: EnvironmentId;
  readonly manage: ReturnType<typeof useMobileBotManage>;
  readonly mainName: string;
  readonly draftName?: string | undefined;
  readonly onClose: () => void;
}) {
  const { bot, manage } = props;
  const initialModel = bot.defaultModelSelection;
  const [model, setModel] = useState<BotProfile["defaultModelSelection"]>(initialModel);
  // Only a member has a model of its own; the main bot's is the GOAT Bot model setting.
  const memberModelEditable = useMobileGoatBotMemberModelEditable(props.environmentId).editable;
  const modelEditable = memberModelEditable && bot.role === "member";
  // Only a member has a colour; the main bot keeps the theme's neutral.
  const colorEditable = useMobileGoatBotColorEditable(props.environmentId) && bot.role === "member";
  const modelChanged = modelEditable && !sameModel(model, initialModel);
  return (
    <MobileBotProfileSheet
      mode="edit"
      initial={bot}
      draftName={props.draftName}
      canSubmit={manage.canEdit}
      extraChanged={modelChanged}
      colorEditable={colorEditable}
      onClose={props.onClose}
      onSubmit={(changes) => manage.update(bot, changes, modelChanged ? model : undefined)}
    >
      {modelEditable ? (
        <MobileNewBotModel
          environmentId={props.environmentId}
          model={model}
          onChange={setModel}
          mainName={props.mainName}
        />
      ) : null}
    </MobileBotProfileSheet>
  );
}

function sameModel(
  left: BotProfile["defaultModelSelection"],
  right: BotProfile["defaultModelSelection"],
) {
  if (left === null || right === null) return left === right;
  return left.instanceId === right.instanceId && left.model === right.model;
}
