import { botManageFailure } from "@goat/client-runtime/goatBot";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotProfile, EnvironmentId, ModelSelection } from "@goat/contracts";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import { GoatBotModelField } from "./GoatBotModelField";
import { GoatBotProfileDialog } from "./GoatBotProfileDialog";

const EMPTY = { name: "", avatar: null, purpose: "" };

/** Creates a member bot; one request id per opening, so a retried save returns the same bot. */
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
  /** The name being created while the request runs, then null. */
  readonly onPending?: ((name: string | null) => void) | undefined;
  readonly mainName?: string;
}) {
  const [clientRequestId] = useState(randomUUID);
  const [model, setModel] = useState<ModelSelection | null>(null);
  const create = useAtomCommand(channelEnvironment.createBot, { reportFailure: false });
  return (
    <GoatBotProfileDialog
      mode="create"
      initial={EMPTY}
      canSubmit={canSubmit}
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
          },
        });
        if (result._tag === "Failure") return botManageFailure(squashAtomCommandFailure(result));
        onCreated(result.value.bot);
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
