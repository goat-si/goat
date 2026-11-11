import type { BotRosterEntry } from "@goat/client-runtime/goatBot";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { useMobileBotsNeedingYou } from "./useMobileBotsNeedingYou";

/**
 * Above the bot list: how much waits on the person across every bot and the newest ask, in one
 * line. It opens in place to one row per waiting bot, and a row opens that bot's chat.
 */
export function MobileNeedsYouStrip(props: {
  readonly bots: ReadonlyArray<BotRosterEntry>;
  /** Changes with the main bot's conversation, so its count is read again. */
  readonly mainRevision?: string | undefined;
  readonly onOpenBot: (bot: BotRosterEntry) => void;
}) {
  const needs = useMobileBotsNeedingYou(props.bots, props.mainRevision);
  const [open, setOpen] = useState(false);
  const first = needs.rows[0];
  if (first === undefined) return null;
  const line = first.ask
    ? `${first.name}: ${first.ask.text}`
    : needs.rows.map((row) => row.name).join(", ");
  return (
    <View className="mx-4 my-2 overflow-hidden rounded-2xl bg-goat-bot-message">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${needs.total} waiting for you. ${line}`}
        onPress={() => setOpen((value) => !value)}
        className="min-h-[44px] flex-row items-center gap-2 px-4 py-2"
      >
        <Text className="font-semibold text-foreground">Needs you · {needs.total}</Text>
        <Text numberOfLines={1} className="shrink text-foreground-muted">
          {line}
        </Text>
        <View className="flex-1" />
        <SymbolView
          name={open ? "chevron.up" : "chevron.down"}
          size={11}
          tintColorClassName="accent-icon-muted"
        />
      </Pressable>
      {open
        ? needs.rows.map((row) => (
            <Pressable
              key={row.entry.kind === "main" ? "main" : row.entry.profile.botId}
              accessibilityRole="button"
              accessibilityLabel={`${row.name}, ${row.count} waiting${row.ask ? `: ${row.ask.text}` : ""}`}
              accessibilityHint="Opens the chat"
              onPress={() => props.onOpenBot(row.entry)}
              className="min-h-[44px] justify-center border-t border-border px-4 py-2"
            >
              <Text className="text-foreground">
                {row.name} · {row.count}
              </Text>
              {row.ask ? (
                <Text numberOfLines={1} className="text-foreground-muted">
                  {row.ask.text}
                </Text>
              ) : null}
            </Pressable>
          ))
        : null}
    </View>
  );
}
