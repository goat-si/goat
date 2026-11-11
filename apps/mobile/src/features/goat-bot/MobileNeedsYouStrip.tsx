import type { BotRosterEntry } from "@goat/client-runtime/goatBot";
import type { ChannelOpenAsk } from "@goat/contracts";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { goatBotTime } from "./GoatBotMessageParts";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";
import { useMobileOpenAsks } from "./useMobileOpenAsks";

/**
 * Above the bot list: how much waits on the person across every bot, and the newest ask with its
 * bot and time, in one line. It opens in place to every ask, newest first; an ask opens its bot's
 * chat. A failed read says so rather than looking like nothing waits.
 */
export function MobileNeedsYouStrip(props: {
  readonly bots: ReadonlyArray<BotRosterEntry>;
  readonly onOpenBot: (bot: BotRosterEntry) => void;
}) {
  const { botRef } = useMobileGoatBotHomeMode();
  const open = useMobileOpenAsks(botRef?.environmentId ?? null);
  const [expanded, setExpanded] = useState(false);
  if (open.state === "failed") {
    return (
      <View className="mx-4 my-2 rounded-2xl bg-goat-bot-message">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Couldn't check what waits for you. Try again"
          onPress={open.retry}
          className="min-h-[44px] justify-center px-4 py-2"
        >
          <Text className="text-foreground-muted">
            Couldn't check what waits for you. <Text className="text-foreground">Try again</Text>
          </Text>
        </Pressable>
      </View>
    );
  }
  if (open.state !== "ready" || open.asks.length === 0) return null;
  const main = props.bots.find((entry) => entry.kind === "main");
  // The main bot's asks may name it before its profile exists; any bot not in the roster is it.
  const botOf = (ask: ChannelOpenAsk) =>
    props.bots.find((entry) => entry.profile?.botId === ask.botId) ?? main ?? null;
  const nameOf = (ask: ChannelOpenAsk) => botOf(ask)?.profile?.name ?? "GOAT Bot";
  const count = `${open.total}${open.truncated ? "+" : ""}`;
  const newest = open.asks[0];
  if (newest === undefined) return null;
  const line = `${nameOf(newest)}: ${newest.text}`;
  const openAsk = (ask: ChannelOpenAsk) => {
    const bot = botOf(ask);
    if (bot !== null) props.onOpenBot(bot);
  };
  return (
    <View className="mx-4 my-2 overflow-hidden rounded-2xl bg-goat-bot-message">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${count} waiting for you. ${line}`}
        onPress={() => setExpanded((value) => !value)}
        className="min-h-[44px] flex-row items-center gap-2 px-4 py-2"
      >
        <Text className="font-semibold text-foreground">Needs you · {count}</Text>
        <Text numberOfLines={1} className="shrink text-foreground-muted">
          {line}
        </Text>
        <View className="flex-1" />
        <Text className="text-xs text-foreground-muted">{goatBotTime(newest.askedAt)}</Text>
        <SymbolView
          name={expanded ? "chevron.up" : "chevron.down"}
          size={11}
          tintColorClassName="accent-icon-muted"
        />
      </Pressable>
      {expanded
        ? open.asks.map((ask) => (
            <Pressable
              key={JSON.stringify([ask.taskId, ask.questionId ?? null, ask.requestId ?? null])}
              accessibilityRole="button"
              accessibilityLabel={`${nameOf(ask)}, ${goatBotTime(ask.askedAt)}: ${ask.text}`}
              accessibilityHint="Opens the chat"
              onPress={() => openAsk(ask)}
              className="min-h-[44px] justify-center border-t border-border px-4 py-2"
            >
              <Text className="text-foreground">
                {nameOf(ask)} · {goatBotTime(ask.askedAt)}
              </Text>
              <Text numberOfLines={2} className="text-foreground-muted">
                {ask.text}
              </Text>
            </Pressable>
          ))
        : null}
    </View>
  );
}
