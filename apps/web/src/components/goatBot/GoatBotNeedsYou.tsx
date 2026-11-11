import {
  MAIN_BOT_ID,
  type BotProfile,
  type ChannelOpenAsk,
  type EnvironmentId,
} from "@goat/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { RelativeTimeLabel } from "~/components/RelativeTimeLabel";
import { registerCommands, registerMenuAction } from "~/shortcuts/dispatcher";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useGoatBotTaskChanges } from "./useGoatBotTaskChanges";

/** One ask: a task can wait on several, each its own question or request. */
const askKey = (ask: ChannelOpenAsk) =>
  `${ask.botId}:${ask.taskId}:${ask.questionId ?? ask.requestId ?? ask.kind}`;

export function GoatBotNeedsYou({
  environmentId,
  bots,
  visible,
}: {
  environmentId: EnvironmentId;
  bots: ReadonlyArray<BotProfile>;
  visible: boolean;
}) {
  const environment = useEnvironment(environmentId);
  // A client without the read grant sees nothing here, not a failure.
  const permitted = useAtomValue(channelEnvironment.listOpenAsksPermission(environmentId));
  const supported =
    permitted && environment?.serverConfig?.environment.capabilities.goatBotOpenAsks === true;
  const changes = useGoatBotTaskChanges(environmentId);
  const query = useEnvironmentQuery(
    supported ? channelEnvironment.listOpenAsks({ environmentId, input: {} }) : null,
  );
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const lastAsk = useRef<string | null>(null);
  const refresh = query.refresh;
  // oxlint-disable-next-line goat/react-effect-budget -- The server signal invalidates the cached open asks.
  useEffect(() => {
    if (supported && changes) refresh();
  }, [supported, changes, refresh]);
  const asks = query.data?.asks;
  const openAsk = (ask: ChannelOpenAsk) => {
    lastAsk.current = askKey(ask);
    void navigate({
      to: "/bot",
      search: {
        task: ask.taskId,
        ...(ask.botId === MAIN_BOT_ID ? {} : { bot: ask.botId }),
      },
    });
  };
  const openNext = useStableCallback(() => {
    if (!asks?.length) return false;
    const previous = asks.findIndex((ask) => askKey(ask) === lastAsk.current);
    const ask = asks[(previous + 1) % asks.length];
    if (!ask) return false;
    openAsk(ask);
  });
  // oxlint-disable-next-line goat/react-effect-budget -- Register the shared keybinding and palette action while this environment is available.
  useEffect(() => {
    if (!supported) return;
    const stopKey = registerCommands({
      "goatBot.nextAsk": (event) => {
        if (openNext() === false) return false;
        event.preventDefault();
      },
    });
    const stopAction = registerMenuAction("goatBot.nextAsk", () => {
      openNext();
    });
    return () => {
      stopKey();
      stopAction();
    };
  }, [supported, openNext]);
  if (!supported || !visible) return null;
  if (query.data === null) {
    if (query.error === null) return null;
    return (
      <div className="px-3 py-2 text-sm">
        <p>Couldn't check what waits for you.</p>
        <button type="button" className="underline" onClick={refresh}>
          Try again
        </button>
      </div>
    );
  }
  if (query.data.total === 0 && !query.data.truncated && query.error === null) return null;
  const name = (ask: ChannelOpenAsk) =>
    bots.find((bot) => bot.botId === ask.botId)?.name ??
    (ask.botId === MAIN_BOT_ID ? "GOAT Bot" : "Bot");
  const newest = query.data.asks[0];
  return (
    <div className="px-2 py-1 text-sm">
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => {
          if (!expanded) refresh();
          setExpanded(!expanded);
        }}
      >
        <span className="shrink-0 font-semibold">
          Needs you · {query.data.total}
          {query.data.truncated ? "+" : ""}
        </span>
        {!expanded && newest && (
          <span className="min-w-0 truncate text-xs text-sidebar-muted-foreground">
            {newest.text} · {name(newest)} · <RelativeTimeLabel timestamp={newest.askedAt} />
          </span>
        )}
      </button>
      {expanded && (
        <div>
          {query.data.asks.map((ask) => (
            <button
              key={askKey(ask)}
              type="button"
              className="block w-full rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => openAsk(ask)}
            >
              <span className="block truncate">{ask.text}</span>
              <span className="block text-xs text-sidebar-muted-foreground">
                {name(ask)} · <RelativeTimeLabel timestamp={ask.askedAt} />
              </span>
            </button>
          ))}
          {query.data.asks.length < query.data.total && (
            <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">
              Showing the newest {query.data.asks.length} of {query.data.total}.
            </p>
          )}
        </div>
      )}
      {query.error !== null && (
        <p className="px-2 text-xs text-sidebar-muted-foreground">
          These asks may be out of date.{" "}
          <button type="button" className="underline" onClick={refresh}>
            Try again
          </button>
        </p>
      )}
    </div>
  );
}
