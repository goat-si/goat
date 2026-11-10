import { useAtomValue } from "@effect/atom-react";
import type { BotProfile } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { useContext, useState } from "react";

import { Button } from "../ui/button";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";
import { GoatBotEditBotDialog } from "./GoatBotEditBotDialog";
import { GoatBotMainProfileContext, GoatBotMemberContext } from "./goatBotMemberContext";

const NO_PERMISSION = Atom.make(false);

/** Profile editing stays available wherever this bot can be edited. */
export function GoatBotHeaderName() {
  const member = useContext(GoatBotMemberContext);
  const main = useContext(GoatBotMainProfileContext);
  const bot = member ?? main;
  const presentation = useEnvironment(bot?.environmentId ?? null);
  const supported =
    bot !== null &&
    presentation?.serverConfig?.environment.capabilities.goatBotProfileEdit === true;
  const canEdit = useAtomValue(
    supported ? channelEnvironment.updateBot.permissionAtom(bot.environmentId) : NO_PERMISSION,
  );
  const [editing, setEditing] = useState<BotProfile | null>(null);
  if (bot === null || !canEdit) return null;
  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(bot)}>
        Edit bot
      </Button>
      {editing !== null ? (
        <GoatBotEditBotDialog bot={editing} canSubmit onClose={() => setEditing(null)} />
      ) : null}
    </>
  );
}
