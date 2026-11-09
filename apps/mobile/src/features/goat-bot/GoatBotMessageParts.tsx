import {
  goatBotAvatarEmoji,
  goatBotReceiptLabel,
  goatBotRejectionText,
  type GoatBotActivity,
  type GoatBotGroupPosition,
  type GoatBotRow,
} from "@goat/client-runtime/goatBot";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import { GoatWordmark } from "../../components/GoatWordmark";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** A message's clock time, or nothing when its timestamp cannot be read. */
export function goatBotTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : timeFormat.format(date);
}

/** A new speaker or a pause opens a group with more air; messages inside a group stay close. */
export const goatBotRowGap = (position: GoatBotGroupPosition) =>
  position === "single" || position === "first" ? 18 : 6;

/** The bot's small avatar: its chosen emoji, else the goat mark on the neutral avatar circle. */
function GoatBotAvatar(props: { readonly emoji?: string | null | undefined }) {
  const emoji = goatBotAvatarEmoji(props.emoji);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="h-5 w-5 items-center justify-center rounded-full border border-goat-avatar-border bg-goat-avatar"
    >
      {emoji !== null ? (
        <Text allowFontScaling={false} style={{ fontSize: 11, lineHeight: 14 }}>
          {emoji}
        </Text>
      ) : (
        <GoatWordmark height={10} colorClassName="accent-goat-avatar-foreground" />
      )}
    </View>
  );
}

/** Opens each run of bot messages, so the speaker and the time read without relying on colour. */
export function GoatBotGroupHeader(props: {
  readonly at: string;
  readonly name: string;
  readonly emoji?: string | null | undefined;
  readonly update?: boolean;
}) {
  const caption = useScaledTextRole("label");
  const time = goatBotTime(props.at);
  return (
    <View className="flex-row items-center gap-2">
      <GoatBotAvatar emoji={props.emoji} />
      <Text style={caption}>
        <Text className="font-semibold text-foreground">{props.name}</Text>
        <Text className="text-foreground-muted">
          {props.update ? " · Update" : ""}
          {time ? ` · ${time}` : ""}
        </Text>
      </Text>
    </View>
  );
}

/** The person's own words: a tailless, high-contrast neutral pill on the right. */
export function GoatBotPersonPill(props: { readonly children: ReactNode }) {
  return (
    <View
      className="bg-prominent-action"
      style={{ borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9, maxWidth: "80%" }}
    >
      {props.children}
    </View>
  );
}

/** The message this one answers, quoted the same way wherever a reply appears. */
export function GoatBotReplyQuote(props: { readonly text: string }) {
  const label = useScaledTextRole("label");
  return (
    <Text
      numberOfLines={2}
      accessibilityLabel={`In reply to: ${props.text}`}
      className="border-l-2 border-border pl-2 text-foreground-muted"
      style={label}
    >
      {props.text}
    </Text>
  );
}

type GoatBotUserRow = Extract<GoatBotRow, { kind: "user" }>;

/**
 * The line under a person's message. Waiting, sending and failed sends say so; otherwise the last
 * message of a group shows its time. Sent, delivered and read states stay quiet.
 */
export function GoatBotPersonCaption(props: {
  readonly row: GoatBotUserRow;
  readonly botName: string;
  readonly canSend: boolean;
  readonly onRetry: (key: string) => void;
  readonly onDiscard?: ((key: string) => void) | undefined;
}) {
  const { delivery } = props.row;
  const caption = useScaledTextRole("caption");
  if (delivery.state === "failed") {
    return (
      <View className="flex-row items-center gap-2">
        <Text className="text-danger-foreground" style={caption}>
          {goatBotRejectionText(delivery.rejectionReason, props.botName)}
        </Text>
        {delivery.rejectionReason === undefined ? (
          <Pressable
            accessibilityRole="button"
            disabled={!props.canSend}
            onPress={() => props.onRetry(delivery.clientKey)}
            className="p-2"
          >
            <Text className="text-sm text-foreground">Retry</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          onPress={() => props.onDiscard?.(delivery.clientKey)}
          className="p-2"
        >
          <Text className="text-sm text-foreground">Discard</Text>
        </Pressable>
      </View>
    );
  }
  const pending =
    delivery.state === "queued" || delivery.state === "sending"
      ? goatBotReceiptLabel(delivery, goatBotTime, props.botName)
      : null;
  const endsGroup = props.row.groupPosition === "last" || props.row.groupPosition === "single";
  const time = goatBotTime(props.row.createdAt);
  if (!pending && (!endsGroup || !time)) return null;
  return (
    <Text
      className="text-foreground-muted"
      style={caption}
      accessibilityLabel={pending?.accessibleText ?? `Sent at ${time}`}
    >
      {pending?.text ?? time}
    </Text>
  );
}

/**
 * What the bot is doing, as one quiet line under the conversation. It is static on purpose: a
 * looping animation would repaint the list the whole time a reply is pending.
 */
export function GoatBotActivityLine(props: {
  readonly activity: GoatBotActivity;
  readonly botName: string;
}) {
  const label = useScaledTextRole("label");
  const line =
    props.activity.state === "working" ? `Working · ${props.activity.text}` : props.activity.text;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${props.botName}: ${line}`}
      className="flex-row items-center gap-2"
      style={{ marginTop: 18 }}
    >
      <View className="h-1.5 w-1.5 rounded-full bg-foreground-muted" />
      <Text numberOfLines={1} className="flex-1 text-foreground-muted" style={label}>
        {line}
      </Text>
    </View>
  );
}
