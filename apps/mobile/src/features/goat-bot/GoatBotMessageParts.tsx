import {
  goatBotAvatarEmoji,
  goatBotChoiceLetter,
  goatBotReceiptLabel,
  goatBotRejectionText,
  type GoatBotActivity,
  type GoatBotAccent,
  type GoatBotFaceState,
  type GoatBotGroupPosition,
  type GoatBotRow,
} from "@goat/client-runtime/goatBot";
import { useEffect, type ReactNode } from "react";
import { AccessibilityInfo, Platform, Pressable, Text, View } from "react-native";

import { GoatWordmark } from "../../components/GoatWordmark";
import { GoatBotProgressFace } from "./GoatBotFace";
import { GoatBotShimmerText } from "./GoatBotShimmerText";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** A message's clock time, or nothing when its timestamp cannot be read. */
export function goatBotTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : timeFormat.format(date);
}

/** A new speaker or a pause opens a group with more air; messages inside a group stay close. */
export const goatBotRowGap = (position: GoatBotGroupPosition) =>
  position === "single" || position === "first" ? 16 : 6;

/**
 * The bot's small avatar: its chosen emoji or initial, on its color when it has one, else the goat
 * mark on the neutral avatar circle.
 */
function GoatBotAvatar(props: {
  readonly emoji?: string | null | undefined;
  readonly accent?: GoatBotAccent | null | undefined;
}) {
  const emoji = goatBotAvatarEmoji(props.emoji);
  const accent = emoji !== null ? (props.accent ?? null) : null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="h-5 w-5 items-center justify-center rounded-full border border-goat-avatar-border bg-goat-avatar"
      style={accent ? { backgroundColor: accent.background } : undefined}
    >
      {emoji !== null ? (
        <Text
          allowFontScaling={false}
          className="text-goat-avatar-foreground"
          style={{ fontSize: 11, lineHeight: 14, ...(accent ? { color: accent.foreground } : {}) }}
        >
          {emoji}
        </Text>
      ) : (
        <GoatWordmark height={10} colorClassName="accent-goat-avatar-foreground" />
      )}
    </View>
  );
}

/** Opens a run of messages the bot sent on its own, so an update never reads as a reply. */
export function GoatBotUpdateLabel(props: {
  readonly at: string;
  readonly name: string;
  readonly emoji?: string | null | undefined;
  readonly accent?: GoatBotAccent | null | undefined;
}) {
  const caption = useScaledTextRole("label");
  const time = goatBotTime(props.at);
  return (
    <View className="flex-row items-center gap-2" style={{ marginLeft: 14 }}>
      <GoatBotAvatar emoji={props.emoji} accent={props.accent} />
      <Text className="text-foreground-muted" style={caption}>
        {`${props.name} · Update${time ? ` · ${time}` : ""}`}
      </Text>
    </View>
  );
}

/** The bot's words: a tailless soft card on the left, the person's pill without its contrast. */
export function GoatBotCard(props: { readonly children: ReactNode }) {
  return (
    <View
      className="self-start bg-goat-bot-message"
      style={{ borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9, maxWidth: "88%" }}
    >
      {props.children}
    </View>
  );
}

/** The person's own words: a tailless, high-contrast neutral pill on the right. */
export function GoatBotPersonPill(props: {
  readonly children: ReactNode;
  /** A member bot's color; the theme's person color without one. */
  readonly accent?: GoatBotAccent | null | undefined;
}) {
  return (
    <View
      className={props.accent ? undefined : "bg-goat-person-message"}
      style={{
        borderRadius: 20,
        paddingHorizontal: 14,
        paddingVertical: 9,
        maxWidth: "80%",
        ...(props.accent ? { backgroundColor: props.accent.background } : {}),
      }}
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
      style={{ ...label, marginLeft: 14 }}
    >
      {props.text}
    </Text>
  );
}

type GoatBotUserRow = Extract<GoatBotRow, { kind: "user" }>;

/** The time under the last message of a bot group, like the person's; phones have no hover. */
export function GoatBotBotCaption(props: {
  readonly at: string;
  readonly groupPosition: GoatBotGroupPosition;
}) {
  const caption = useScaledTextRole("caption");
  const time = goatBotTime(props.at);
  if (!time || (props.groupPosition !== "last" && props.groupPosition !== "single")) return null;
  return (
    <Text
      className="text-foreground-muted"
      style={{ ...caption, marginLeft: 14 }}
      accessibilityLabel={`Sent at ${time}`}
    >
      {time}
    </Text>
  );
}

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

// The waits goatBotActivity reports; a task's own streamed update can also begin "Waiting…", and
// is a working step, so a wait is one of these exact lines and each is heard once.
const PERSON_WAITS: ReadonlySet<string> = new Set([
  "Waiting for your approval",
  "Waiting for your answer",
  "Waiting for you to sign in",
  "Waiting for you",
  "Waiting on other work",
  "Paused on a usage limit",
]);

/**
 * What the bot is doing now, under the last message: its face and one muted line. The words get the
 * stepped highlight only while it reads or works and the line is in view; a wait on the person or on
 * other work stays still, so the line never shows motion that is not happening.
 */
export function GoatBotActivityLine(props: {
  readonly activity: GoatBotActivity;
  readonly botName: string;
  /** The bot's profile avatar; an emoji replaces the drawn face. */
  readonly emoji?: string | null | undefined;
  readonly accent?: GoatBotAccent | null | undefined;
  /** Whether enough of the line shows on screen for its motion to run. */
  readonly inView: boolean;
}) {
  const label = useScaledTextRole("label");
  const { activity } = props;
  const waits = activity.state === "working" && PERSON_WAITS.has(activity.text);
  const face: GoatBotFaceState =
    activity.state === "reading" ? "reading" : waits ? "waiting" : "working";
  // Screen readers hear when the bot starts or reads, not each working step, and what it waits on:
  // the live part says only that, and a working step is plain text beside it.
  const status = waits
    ? `${props.botName}: ${activity.text}`
    : `${props.botName} is ${face === "reading" ? "reading" : "working"}`;
  const waitStatus = waits ? status : null;
  // oxlint-disable-next-line goat/react-effect-budget -- iOS has no live regions; VoiceOver hears each new wait from here.
  useEffect(() => {
    if (waitStatus !== null && Platform.OS === "ios")
      AccessibilityInfo.announceForAccessibility(waitStatus);
  }, [waitStatus]);
  return (
    <View className="min-h-[32px] flex-row items-center gap-2" style={{ marginTop: 10 }}>
      <View accessible accessibilityLiveRegion="polite" accessibilityLabel={status}>
        <GoatBotProgressFace
          state={face}
          emoji={props.emoji}
          accent={props.accent}
          inView={props.inView}
        />
      </View>
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={activity.text}
        className="min-w-0 flex-1"
      >
        {waits ? (
          <Text numberOfLines={1} className="text-foreground-muted" style={label}>
            {activity.text}
          </Text>
        ) : (
          <GoatBotShimmerText label={activity.text} animate={props.inView} style={label} />
        )}
      </View>
    </View>
  );
}

/**
 * A round letter for one choice; filled in the person's colours once it is their answer, a member
 * bot's colour in its chat.
 */
function GoatBotChoiceBadge(props: {
  readonly letter: string;
  readonly chosen?: boolean;
  readonly accent?: GoatBotAccent | null | undefined;
}) {
  const accent = props.chosen ? (props.accent ?? null) : null;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={
        accent
          ? "h-[26px] w-[26px] items-center justify-center rounded-full"
          : props.chosen
            ? "h-[26px] w-[26px] items-center justify-center rounded-full bg-goat-person-message"
            : "h-[26px] w-[26px] items-center justify-center rounded-full border border-foreground-muted"
      }
      style={accent ? { backgroundColor: accent.background } : undefined}
    >
      <Text
        className={
          accent
            ? "text-xs font-semibold"
            : props.chosen
              ? "text-xs font-semibold text-goat-person-message-foreground"
              : "text-xs font-semibold text-foreground-muted"
        }
        style={accent ? { color: accent.foreground } : undefined}
      >
        {props.letter}
      </Text>
    </View>
  );
}

/**
 * A bot question with choices: one card, the question and its lettered choices. Once answered it
 * keeps the question, dimmed, and only the picked choice; a typed answer stays the person's own
 * message, so the card keeps just the question. The last row hands over to the composer.
 */
export function GoatBotQuestionCard(props: {
  readonly children: ReactNode;
  readonly row: Extract<GoatBotRow, { kind: "bot" }>;
  readonly canAnswer: boolean;
  readonly onPick: (answer: string) => void;
  readonly onSomethingElse?: (() => void) | undefined;
  /** A member bot's colour for the picked answer's badge. */
  readonly accent?: GoatBotAccent | null | undefined;
}) {
  const { row } = props;
  const label = useScaledTextRole("label");
  const open = row.options.length > 0;
  const choices = row.choices ?? row.options;
  const picked = row.answerIndex === undefined ? undefined : choices[row.answerIndex];
  return (
    <View
      className="self-start bg-goat-bot-message"
      style={{ borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9, maxWidth: "88%" }}
    >
      <View style={open ? undefined : { opacity: 0.6 }}>{props.children}</View>
      {open ? (
        <View accessibilityLabel="Choices" className="mt-1.5" style={{ marginHorizontal: -6 }}>
          {row.options.map((option, index) => (
            <Pressable
              key={option}
              accessibilityRole="button"
              accessibilityLabel={`${goatBotChoiceLetter(index)}. ${option}`}
              accessibilityState={{ disabled: !props.canAnswer }}
              disabled={!props.canAnswer}
              onPress={() => props.onPick(option)}
              // 44pt touch target; min-h-11 is only 38.5pt at the app's 14pt rem.
              className="min-h-[44px] flex-row items-center gap-2.5 rounded-xl px-1.5 py-1.5"
              style={props.canAnswer ? undefined : { opacity: 0.5 }}
            >
              <GoatBotChoiceBadge letter={goatBotChoiceLetter(index)} />
              <Text className="shrink text-foreground" style={label}>
                {option}
              </Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Something else"
            accessibilityHint="Type your own answer in the message field"
            accessibilityState={{ disabled: !props.canAnswer }}
            disabled={!props.canAnswer}
            onPress={props.onSomethingElse}
            className="min-h-[44px] flex-row items-center gap-2.5 rounded-xl px-1.5 py-1.5"
            style={props.canAnswer ? undefined : { opacity: 0.5 }}
          >
            <GoatBotChoiceBadge letter={goatBotChoiceLetter(row.options.length)} />
            <Text className="shrink text-foreground-muted" style={label}>
              Something else
            </Text>
          </Pressable>
        </View>
      ) : picked !== undefined && row.answerIndex !== undefined ? (
        <View
          accessible
          accessibilityLabel={`You answered ${goatBotChoiceLetter(row.answerIndex)}: ${picked}${
            row.answerSending ? ", sending" : ""
          }`}
          className="mt-1.5 min-h-[44px] flex-row items-center gap-2.5"
          style={{ marginHorizontal: -6, paddingHorizontal: 6 }}
        >
          <GoatBotChoiceBadge
            letter={goatBotChoiceLetter(row.answerIndex)}
            chosen
            accent={props.accent}
          />
          <Text className="shrink text-foreground" style={label}>
            {picked}
          </Text>
          {row.answerSending ? (
            <Text className="text-xs text-foreground-muted">Sending…</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
