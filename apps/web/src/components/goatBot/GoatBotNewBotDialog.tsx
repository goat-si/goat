import { botManageFailure } from "@goat/client-runtime/goatBot";
import { botProfileChanges } from "@goat/client-runtime/state/channels";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotProfile, EnvironmentId, ModelSelection } from "@goat/contracts";
import { modelSelectionsEqual } from "@goat/shared/model";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { GoatBotModelField } from "./GoatBotModelField";
import { GoatBotProfileDialog } from "./GoatBotProfileDialog";

const EMPTY = { name: "", avatar: null, purpose: "" };

/**
 * Creates a member bot; one request id per opening, so a retried save returns the same bot. Edits
 * made after a try the server kept but this client saw fail are sent as a change to that bot.
 */
export function GoatBotNewBotDialog({
  environmentId,
  canSubmit,
  onCreated,
  onClose,
  onPending,
  mainName = "GOAT Bot",
}: {
  readonly environmentId: EnvironmentId;
  readonly canSubmit: boolean;
  readonly onCreated: (bot: BotProfile) => void;
  readonly onClose: () => void;
  /** The name being created while the request runs, then null when it failed; a bot it made stays. */
  readonly onPending?: ((name: string | null) => void) | undefined;
  readonly mainName?: string;
}) {
  const [clientRequestId] = useState(randomUUID);
  const [model, setModel] = useState<ModelSelection | null>(null);
  const presentation = useEnvironment(environmentId);
  const capabilities = presentation?.serverConfig?.environment.capabilities;
  const colorEditable = capabilities?.goatBotProfileColor === true;
  const modelEditable = capabilities?.goatBotMemberModelEdit === true;
  const create = useAtomCommand(channelEnvironment.createBot, { reportFailure: false });
  const update = useAtomCommand(channelEnvironment.updateBot, { reportFailure: false });
  return (
    <GoatBotProfileDialog
      mode="create"
      initial={EMPTY}
      canSubmit={canSubmit}
      colorEditable={colorEditable}
      onClose={onClose}
      onPending={onPending}
      onSubmit={async (changes) => {
        const result = await create({
          environmentId,
          input: {
            clientRequestId,
            name: changes.name ?? "",
            avatar: changes.avatar ?? null,
            purpose: changes.purpose ?? "",
            defaultModelSelection: model,
            // Only a server with the capability was offered a swatch, so an older one sees nothing.
            ...(changes.color == null ? {} : { color: changes.color }),
          },
        });
        if (result._tag === "Failure") return botManageFailure(squashAtomCommandFailure(result));
        const bot = result.value.bot;
        const missed = botProfileChanges("edit", bot, {
          name: changes.name ?? "",
          avatar: changes.avatar ?? "",
          purpose: changes.purpose ?? "",
          ...(colorEditable ? { color: changes.color ?? null } : {}),
        });
        // An older server drops a model from a change, so only one that reads it is sent one.
        const modelMissed = modelEditable && !sameModel(model, bot.defaultModelSelection);
        if (Object.keys(missed).length === 0 && !modelMissed) {
          onCreated(bot);
          return null;
        }
        const changed = await update({
          environmentId,
          input: {
            botId: bot.botId,
            ...missed,
            ...(modelMissed ? { defaultModelSelection: model } : {}),
          },
        });
        if (changed._tag === "Failure") return botManageFailure(squashAtomCommandFailure(changed));
        onCreated(changed.value.bot);
        return null;
      }}
    >
      <GoatBotModelField
        environmentId={environmentId}
        model={model}
        onChange={setModel}
        mainName={mainName}
        label="New bot model"
      />
    </GoatBotProfileDialog>
  );
}

function sameModel(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return left === null || right === null ? left === right : modelSelectionsEqual(left, right);
}
