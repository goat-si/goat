import { useAtomValue } from "@effect/atom-react";
import type { BotProfile } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { type ReactNode, useContext, useState } from "react";

import { ChevronRightIcon } from "~/components/solar";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";
import { GoatBotEditBotDialog } from "./GoatBotEditBotDialog";
import { GoatBotMainProfileContext, GoatBotMemberContext } from "./goatBotMemberContext";

const NO_PERMISSION = Atom.make(false);

/** The chat's name chip with the bot's face; opens the profile where this connection may edit it. */
export function GoatBotHeaderName({
  title,
  avatar,
}: {
  readonly title: string;
  readonly avatar: ReactNode;
}) {
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
  const name = (
    <>
      <span className="goat-name-avatar flex shrink-0">{avatar}</span>
      <span className="min-w-0 truncate">{title}</span>
      <ChevronRightIcon aria-hidden className="size-3 shrink-0" />
    </>
  );
  if (bot === null || !canEdit) {
    return <h1 className="goat-name-capsule max-w-full min-w-0 text-foreground">{name}</h1>;
  }
  return (
    <h1 className="flex min-w-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`${title} profile`}
        className="goat-name-capsule max-w-full min-w-0 text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={() => setEditing(bot)}
      >
        {name}
      </button>
      {editing !== null ? (
        <GoatBotEditBotDialog bot={editing} canSubmit onClose={() => setEditing(null)} />
      ) : null}
    </h1>
  );
}
