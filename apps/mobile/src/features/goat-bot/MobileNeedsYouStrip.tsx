import type { BotRosterEntry } from "@goat/client-runtime/goatBot";
import {
  type BotProfile,
  type ChannelOpenAsk,
  type ChannelTaskId,
  MAIN_BOT_ID,
} from "@goat/contracts";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { goatBotTime } from "./GoatBotMessageParts";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";
import { useMobileOpenAsks } from "./useMobileOpenAsks";

/**
 * Above the bot list: how much waits on the person across every bot, and the newest ask with its
 * bot and time, in one line. It opens in place to the asks, newest first; an ask opens its task in
 * its bot's chat. A failed or partial read says so rather than looking like nothing waits.
 */
export function MobileNeedsYouStrip(props: {
  /** The shown bots; hidden members still have asks, and open from here too. */
  readonly bots: ReadonlyArray<BotRosterEntry>;
  readonly hidden: ReadonlyArray<BotProfile>;
  /** The roster is on screen; coming back into view reads the asks again. */
  readonly visible: boolean;
  readonly onOpenAsk: (bot: BotRosterEntry, taskId: ChannelTaskId) => void;
}) {
  const { botRef } = useMobileGoatBotHomeMode();
  const open = useMobileOpenAsks(botRef?.environmentId ?? null, props.visible);
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
  if (open.state !== "ready" || (open.total === 0 && !open.truncated)) return null;
  const main = props.bots.find((entry) => entry.kind === "main") ?? null;
  const members = [
    ...props.bots.flatMap((entry) => (entry.kind === "member" ? [entry.profile] : [])),
    ...props.hidden,
  ];
  // Each ask names its bot; one not among the profiles yet has no destination until they load.
  const botOf = (ask: ChannelOpenAsk): { entry: BotRosterEntry | null; name: string } => {
    if (ask.botId === MAIN_BOT_ID) return { entry: main, name: main?.profile?.name ?? "GOAT Bot" };
    const profile = members.find((member) => member.botId === ask.botId);
    return profile === undefined
      ? { entry: null, name: "A bot" }
      : { entry: { kind: "member", profile }, name: profile.name };
  };
  const count = `${open.total}${open.truncated ? "+" : ""}`;
  const title = open.total > 0 ? `Needs you · ${count}` : "Needs you";
  const stale =
    open.staleRetry === null ? null : (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Couldn't refresh, this may be out of date. Try again"
        onPress={open.staleRetry}
        className="min-h-[44px] justify-center border-t border-border px-4 py-2"
      >
        <Text className="text-xs text-foreground-muted">
          Couldn't refresh, this may be out of date.{" "}
          <Text className="text-foreground">Try again</Text>
        </Text>
      </Pressable>
    );
  const newest = open.asks[0];
  if (newest === undefined) {
    // The server stopped before it read all the waiting work, and found none in what it read.
    return (
      <View className="mx-4 my-2 overflow-hidden rounded-2xl bg-goat-bot-message">
        <View className="px-4 py-2">
          <Text className="font-semibold text-foreground">{title}</Text>
          <Text className="text-foreground-muted">Some waiting work couldn't be read.</Text>
        </View>
        {stale}
      </View>
    );
  }
  const line = `${botOf(newest).name}: ${newest.text}`;
  const hiddenRows = open.total - open.asks.length;
  return (
    <View className="mx-4 my-2 overflow-hidden rounded-2xl bg-goat-bot-message">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${count} waiting for you${open.staleRetry ? ", may be out of date" : ""}. ${line}`}
        onPress={() => setExpanded((value) => !value)}
        className="min-h-[44px] flex-row items-center gap-2 px-4 py-2"
      >
        <Text className="font-semibold text-foreground">{title}</Text>
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
      {stale}
      {expanded ? (
        <>
          {open.asks.map((ask) => {
            const bot = botOf(ask);
            const entry = bot.entry;
            return (
              <Pressable
                key={JSON.stringify([ask.taskId, ask.questionId ?? null, ask.requestId ?? null])}
                accessibilityRole="button"
                accessibilityLabel={`${bot.name}, ${goatBotTime(ask.askedAt)}: ${ask.text}`}
                accessibilityHint={entry ? "Opens the task" : undefined}
                accessibilityState={{ disabled: entry === null }}
                disabled={entry === null}
                onPress={entry ? () => props.onOpenAsk(entry, ask.taskId) : undefined}
                className="min-h-[44px] justify-center border-t border-border px-4 py-2"
              >
                <Text className="text-foreground">
                  {bot.name} · {goatBotTime(ask.askedAt)}
                </Text>
                <Text numberOfLines={2} className="text-foreground-muted">
                  {ask.text}
                </Text>
              </Pressable>
            );
          })}
          {hiddenRows > 0 ? (
            <Text className="border-t border-border px-4 py-2 text-xs text-foreground-muted">
              {`Showing the newest ${open.asks.length} of ${count}.`}
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
