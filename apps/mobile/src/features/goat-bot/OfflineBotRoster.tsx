import { goatBotAccent } from "@goat/client-runtime/goatBot";
import { MAIN_BOT_ID, type EnvironmentId } from "@goat/contracts";
import type { ReactNode } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { GoatBotFaceAvatar } from "./GoatBotFace";
import { useOfflineBotSummary, type OfflineBotSummary } from "./useOfflineBotSummary";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function asOf(readAt: number): string {
  const read = new Date(readAt);
  const format = read.toDateString() === new Date().toDateString() ? timeFormat : dateTimeFormat;
  return `As of ${format.format(read)}`;
}

export default function OfflineBotRoster(props: {
  readonly header?: ReactNode;
  readonly environmentId: EnvironmentId | null;
  readonly visible: boolean;
  readonly computer: string | null;
  readonly openBot: (
    botId: string,
    summaryEnvironmentId: EnvironmentId | null,
  ) => (() => void) | undefined;
}) {
  const summary = useOfflineBotSummary(props.environmentId, props.visible);
  const insets = useSafeAreaInsets();
  const bottomClearance =
    Math.max(insets.bottom, useWorkspaceTabs()?.bottomClearance ?? 0) -
    (Platform.OS === "ios" ? insets.bottom : 0);
  const asks = summary?.asks ?? null;
  const bots = summary?.bots ?? null;
  const counts = new Map<string, number>();
  for (const ask of asks?.data.asks ?? []) counts.set(ask.botId, (counts.get(ask.botId) ?? 0) + 1);
  const hasMore = asks !== null && (asks.data.truncated || asks.data.total > asks.data.asks.length);
  const rows = bots?.data ?? [];
  const main = rows.find((row) => row.role === "main");
  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: bottomClearance }}
    >
      {props.header}
      <View className="mx-4 my-2 rounded-2xl bg-goat-bot-message px-4 py-3">
        {asks === null ? (
          <Text className="text-foreground-muted">
            Needs you · unavailable while {props.computer ?? "its computer"} is offline
          </Text>
        ) : (
          <>
            <Text className="font-semibold text-foreground">
              Needs you · {asks.data.total}
              {asks.data.truncated ? "+" : ""}
            </Text>
            <Text className="text-xs text-foreground-muted">{asOf(asks.readAt)}</Text>
          </>
        )}
      </View>
      {bots === null ? null : (
        <Text className="mx-4 mt-2 text-xs text-foreground-muted">
          Offline · {asOf(bots.readAt)}
        </Text>
      )}
      <OfflineBotRow
        name={main?.name ?? "GOAT Bot"}
        row={main}
        count={counts.get(main?.botId ?? MAIN_BOT_ID)}
        hasMore={hasMore}
        onPress={props.openBot(MAIN_BOT_ID, summary?.environmentId ?? null)}
      />
      {rows
        .filter((row) => row.role === "member")
        .map((row) => (
          <OfflineBotRow
            key={row.botId}
            name={row.name}
            row={row}
            count={counts.get(row.botId)}
            hasMore={hasMore}
            onPress={props.openBot(row.botId, summary?.environmentId ?? null)}
          />
        ))}
    </ScrollView>
  );
}

function OfflineBotRow(props: {
  readonly name: string;
  readonly row?: NonNullable<OfflineBotSummary["bots"]>["data"][number] | undefined;
  readonly count?: number | undefined;
  readonly hasMore: boolean;
  readonly onPress?: (() => void) | undefined;
}) {
  const content = (
    <>
      <GoatBotFaceAvatar
        state="sleeping"
        size={40}
        emoji={props.row?.avatar}
        accent={props.row ? goatBotAccent(props.row) : null}
      />
      <Text className="flex-1 text-base font-semibold text-foreground">{props.name}</Text>
      {props.count === undefined ? null : (
        <Text className="text-sm text-foreground-muted">
          {props.count}
          {props.hasMore ? "+" : ""} waiting
        </Text>
      )}
    </>
  );
  const className = "mx-4 min-h-[52px] flex-row items-center gap-3 px-4 py-2";
  return props.onPress ? (
    <Pressable accessibilityRole="button" className={className} onPress={props.onPress}>
      {content}
    </Pressable>
  ) : (
    <View className={className}>{content}</View>
  );
}
