import { botManageFailure } from "@goat/client-runtime/goatBot";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotProfile, EnvironmentId, ModelSelection } from "@goat/contracts";
import { createModelSelection } from "@goat/shared/model";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { GoatBotProfileDialog } from "./GoatBotProfileDialog";
import { useGoatBotModel } from "./useGoatBotModel";

const EMPTY = { name: "", avatar: null, purpose: "" };

/** Creates a member bot; one request id per opening, so a retried save returns the same bot. */
export function GoatBotNewBotDialog({
  environmentId,
  canSubmit,
  onCreated,
  onClose,
  mainName = "GOAT Bot",
}: {
  readonly environmentId: EnvironmentId;
  readonly canSubmit: boolean;
  readonly onCreated: (bot: BotProfile) => void;
  readonly onClose: () => void;
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
      <NewBotModel
        environmentId={environmentId}
        model={model}
        onChange={setModel}
        mainName={mainName}
      />
    </GoatBotProfileDialog>
  );
}

function NewBotModel({
  environmentId,
  model,
  onChange,
  mainName,
}: {
  readonly environmentId: EnvironmentId;
  readonly model: ModelSelection | null;
  readonly onChange: (model: ModelSelection) => void;
  readonly mainName: string;
}) {
  const { selection, entries, options } = useGoatBotModel(environmentId);
  const shown = model ?? selection;
  const name =
    entries
      .find((entry) => entry.instanceId === shown.instanceId)
      ?.models.find((entry) => entry.slug === shown.model)?.name ?? shown.model;
  return (
    <div className="grid gap-1.5 text-sm">
      Model
      <div className="flex items-center gap-2">
        <ProviderModelPicker
          environmentId={environmentId}
          activeInstanceId={shown.instanceId}
          model={shown.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={options}
          triggerAriaLabel={`New bot model: ${name}`}
          onInstanceModelChange={(instanceId, slug) =>
            onChange(createModelSelection(instanceId, slug))
          }
        />
        {model === null ? (
          <span className="text-xs text-muted-foreground">Same as {mainName}</span>
        ) : null}
      </div>
    </div>
  );
}
