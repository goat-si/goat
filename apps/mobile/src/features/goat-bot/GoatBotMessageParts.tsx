import {
  goatBotAvatarEmoji,
  goatBotReceiptLabel,
  goatBotRejectionText,
  type GoatBotActivity,
  type GoatBotGroupPosition,
  type GoatBotRow,
} from "@goat/client-runtime/goatBot";
import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import { GoatWordmark } from "../../components/GoatWordmark";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";

/** The activity line also shows how long the followed work has run and, opened, what it is. */
export type GoatBotTimelineActivity = GoatBotActivity & {
  readonly since?: string;
  readonly title?: string;
};

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** A message's clock time, or nothing when its timestamp cannot be read. */
export function goatBotTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : timeFormat.format(date);
}

/** A new speaker or a pause opens a group with more air; messages inside a group stay close. */
export const goatBotRowGap = (position: GoatBotGroupPosition) =>
  position === "single" || position === "first" ? 16 : 6;

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
        <Text
          allowFontScaling={false}
          className="text-goat-avatar-foreground"
          style={{ fontSize: 11, lineHeight: 14 }}
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
}) {
  const caption = useScaledTextRole("label");
  const time = goatBotTime(props.at);
  return (
    <View className="flex-row items-center gap-2" style={{ marginLeft: 14 }}>
      <GoatBotAvatar emoji={props.emoji} />
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
export function GoatBotPersonPill(props: { readonly children: ReactNode }) {
  return (
    <View
      className="bg-goat-person-message"
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
      style={{ ...label, marginLeft: 14 }}
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

/** The web line's wording: "just now", "12s", "3m", "2h", "4d"; empty when unreadable. */
export function goatBotElapsedLabel(since: string, nowMs: number): string {
  const start = Date.parse(since);
  if (Number.isNaN(start)) return "";
  const seconds = Math.floor((nowMs - start) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

const ELAPSED_TICK_MS = 1_000;

/** Checked each second like the web line; the row re-renders only when the label changes. */
function useElapsedLabel(since: string | null): string | null {
  // Stable per start time, so a list re-render does not restart the interval.
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (since === null) return () => {};
      const timer = setInterval(onChange, ELAPSED_TICK_MS);
      return () => clearInterval(timer);
    },
    [since],
  );
  const read = () => (since === null ? null : goatBotElapsedLabel(since, Date.now()) || null);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * One line for what the bot is doing: a still icon, what it says, and for how long. Work it
 * follows opens to show which task that is. Nothing here moves; the label is the progress.
 */
export function GoatBotActivityLine(props: {
  readonly activity: GoatBotTimelineActivity;
  readonly botName: string;
  /** When the reading or the followed work began; the elapsed time counts from it. */
  readonly since?: string | null;
}) {
  const label = useScaledTextRole("label");
  const [open, setOpen] = useState(false);
  const { activity } = props;
  const elapsed = useElapsedLabel(props.since ?? activity.since ?? null);
  const waiting = activity.state === "working" && activity.text.startsWith("Waiting");
  const title = activity.state === "working" ? (activity.title ?? null) : null;
  const line = elapsed ? `${activity.text} · ${elapsed}` : activity.text;
  return (
    <View style={{ marginTop: 18 }}>
      <View className="min-h-[32px] flex-row items-center gap-2">
        <SymbolView
          name={activity.state === "reading" ? "eye" : waiting ? "clock" : "circle.inset.filled"}
          size={14}
          tintColorClassName={waiting ? "accent-warning-foreground" : "accent-foreground"}
        />
        {/* The live region announces what changed, never the ticking time. */}
        <Text
          accessibilityRole="text"
          accessibilityLiveRegion="polite"
          accessibilityLabel={`${props.botName}: ${activity.text}`}
          numberOfLines={1}
          className="shrink text-foreground-muted"
          style={label}
        >
          {line}
        </Text>
        {title !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={open ? "Hide work details" : "Show work details"}
            accessibilityState={{ expanded: open }}
            hitSlop={8}
            onPress={() => setOpen((value) => !value)}
            className="h-8 w-8 items-center justify-center"
          >
            <SymbolView
              name={open ? "chevron.up" : "chevron.down"}
              size={12}
              tintColorClassName="accent-icon-muted"
            />
          </Pressable>
        ) : null}
      </View>
      {open && title !== null ? (
        <Text
          selectable
          className="pb-1 text-foreground-muted"
          style={{ ...label, marginLeft: 22 }}
        >
          {title}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A bot question that offers answers: its words in the bot's card with the answers as pills
 * below. Once answered, it settles to one line naming the answer, which opens to the question.
 */
export function GoatBotQuestionCard(props: {
  readonly children: ReactNode;
  readonly options: ReadonlyArray<string>;
  readonly canAnswer: boolean;
  readonly onPick: (answer: string) => void;
  /** The answer the person sent; absent while the question is open. */
  readonly answered?: string | null | undefined;
}) {
  const answered = props.answered ?? null;
  if (answered !== null) {
    return <GoatBotAnsweredQuestion answer={answered}>{props.children}</GoatBotAnsweredQuestion>;
  }
  return (
    <View accessibilityLabel="Question" className="gap-2">
      <GoatBotCard>{props.children}</GoatBotCard>
      <View accessibilityLabel="Suggested answers" className="flex-row flex-wrap gap-2">
        {props.options.map((answer) => (
          <Pressable
            key={answer}
            accessibilityRole="button"
            disabled={!props.canAnswer}
            onPress={() => props.onPick(answer)}
            // 44pt touch target; min-h-11 is only 38.5pt at the app's 14pt rem.
            className="min-h-[44px] max-w-full justify-center rounded-full border border-border px-3 py-2"
          >
            <Text numberOfLines={2} className="text-sm text-foreground">
              {answer}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** The settled question, like web's answered summary: one line, opened only when asked. */
function GoatBotAnsweredQuestion(props: { readonly answer: string; readonly children: ReactNode }) {
  const label = useScaledTextRole("label");
  const [open, setOpen] = useState(false);
  return (
    <View className="self-start bg-goat-bot-message" style={{ borderRadius: 18, maxWidth: "88%" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Answered: ${props.answer}`}
        accessibilityHint={open ? "Hides the question" : "Shows the question"}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        className="min-h-[44px] flex-row items-center gap-2 py-2"
        style={{ paddingHorizontal: 14 }}
      >
        <SymbolView name="checkmark" size={14} tintColorClassName="accent-icon-muted" />
        <Text numberOfLines={1} className="shrink text-foreground" style={label}>
          <Text className="text-foreground-muted">Answered: </Text>
          <Text className="font-medium">{props.answer}</Text>
        </Text>
        <View className="ml-auto">
          <SymbolView
            name={open ? "chevron.down" : "chevron.right"}
            size={12}
            tintColorClassName="accent-icon-muted"
          />
        </View>
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>{props.children}</View>
      ) : null}
    </View>
  );
}
