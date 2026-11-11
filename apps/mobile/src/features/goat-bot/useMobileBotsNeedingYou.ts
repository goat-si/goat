import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { BotRosterEntry } from "@goat/client-runtime/goatBot";
import type { BotId, EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { channelEnvironment } from "../../state/channels";
import { useEnvironments } from "../../state/environments";
import { goatBotNeedsYou } from "./goatBotNeedsYou";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";

type Target = { readonly environmentId: EnvironmentId; readonly botId: BotId | null };
const statusAtom = (target: Target) =>
  channelEnvironment.botStatus({
    environmentId: target.environmentId,
    input: target.botId === null ? {} : { botId: target.botId },
  });

// The same per-bot reads the member rows use, gathered so the strip can add them up.
const statuses = Atom.family((key: string) => {
  const targets = JSON.parse(key) as ReadonlyArray<Target | null>;
  return Atom.make((get) =>
    targets.map((target) =>
      target === null ? null : Option.getOrNull(AsyncResult.value(get(statusAtom(target)))),
    ),
  );
});
const NO_MAIN = Atom.make(AsyncResult.initial<never, never>(false));

/**
 * What waits on the person across the roster. Members read their count again as their rows
 * follow their conversations; the main bot's is read again when `mainRevision` changes.
 */
export function useMobileBotsNeedingYou(
  bots: ReadonlyArray<BotRosterEntry>,
  mainRevision: string | undefined,
) {
  const { presentationById } = useEnvironments();
  const { botRef } = useMobileGoatBotHomeMode();
  const targets = bots.map((entry): Target | null => {
    if (entry.kind === "main") {
      if (botRef === null) return null;
      const presentation = presentationById.get(botRef.environmentId);
      return presentation?.connection.phase === "connected"
        ? { environmentId: botRef.environmentId, botId: null }
        : null;
    }
    const presentation = presentationById.get(entry.profile.environmentId);
    const supported =
      entry.profile.state !== "deleted" &&
      presentation?.connection.phase === "connected" &&
      presentation.serverConfig?.environment.capabilities.goatBotMembers === true;
    return supported
      ? { environmentId: entry.profile.environmentId, botId: entry.profile.botId }
      : null;
  });
  const values = useAtomValue(statuses(JSON.stringify(targets)));
  const main = targets[bots.findIndex((entry) => entry.kind === "main")] ?? null;
  const refreshMain = useAtomRefresh(main === null ? NO_MAIN : statusAtom(main));
  // oxlint-disable-next-line goat/react-effect-budget -- Read the main bot's waiting count again when its conversation changes.
  useEffect(() => {
    if (mainRevision !== undefined) refreshMain();
  }, [mainRevision, refreshMain]);
  return goatBotNeedsYou(
    bots.map((entry, index) => ({
      entry,
      name: entry.profile?.name ?? "GOAT Bot",
      status: values[index] ?? null,
    })),
  );
}
