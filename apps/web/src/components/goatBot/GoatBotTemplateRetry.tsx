import { useAtomValue } from "@effect/atom-react";
import { botManageFailure, botTemplateRetryInput } from "@goat/client-runtime/goatBot";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotProfile } from "@goat/contracts";
import { useState } from "react";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { useGoatBotTemplateSupport } from "./useGoatBotTemplateSupport";

export function GoatBotTemplateRetry({ bot }: { bot: BotProfile }) {
  const allowed = useGoatBotTemplateSupport(bot.environmentId);
  const mayCreate = useAtomValue(channelEnvironment.createBot.permissionAtom(bot.environmentId));
  const create = useAtomCommand(channelEnvironment.createBot, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string>();
  const input = botTemplateRetryInput(bot);
  if (input === undefined || finished) return null;

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-1 text-xs text-muted-foreground">
      <span role="status">{error ?? "1 routine could not be added"}</span>
      {allowed && (
        <Button
          size="xs"
          variant="outline"
          aria-label={`Retry setup for ${bot.name}`}
          disabled={busy || !mayCreate}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            const result = await create({ environmentId: bot.environmentId, input });
            setBusy(false);
            if (result._tag === "Success") {
              if (!result.value.templateAutomationPending) setFinished(true);
            } else {
              setError(botManageFailure(squashAtomCommandFailure(result)));
            }
          }}
        >
          {busy ? "Retrying…" : "Retry"}
        </Button>
      )}
    </div>
  );
}
