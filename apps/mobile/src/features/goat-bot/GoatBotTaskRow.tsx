import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { hasGoatBotMarkdown, type GoatBotTaskCard } from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { GoatBotLinkedText } from "./GoatBotLinkedText";
import { GoatBotMarkdown } from "./GoatBotMarkdown";

type ThreadSelection = Pick<EnvironmentThreadShell, "environmentId" | "id">;

const SUMMARY_LINES = 4;
/** About four lines of body text in a row at its narrowest. */
const SUMMARY_CHARS = 160;

const STATUS_DOT: Record<GoatBotTaskCard["tone"], string> = {
  neutral: "bg-foreground-muted",
  active: "bg-foreground",
  attention: "bg-warning-foreground",
  success: "bg-foreground-muted",
  danger: "bg-danger-foreground",
};

/**
 * A piece of work GOAT Bot started, drawn as one bordered row wherever it appears. With
 * `onOpenTask` the row opens the task's own conversation; otherwise it shows the result and opens
 * the work thread, and remote work names its machine until that machine connects.
 */
export function GoatBotTaskRow(props: {
  readonly card: GoatBotTaskCard;
  readonly onSelectThread: (thread: ThreadSelection) => void;
  readonly onOpenTask?: (() => void) | undefined;
  /** Listed but closed, as when the bot's computer is offline. */
  readonly disabled?: boolean;
  /** Leaves the status out, for older work whose status is on the bot's Home. */
  readonly statusHidden?: boolean;
}) {
  const { card } = props;
  const titleText = useScaledTextRole("body");
  const metaText = useScaledTextRole("label");
  const target = card.target;
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const unreachableHost =
    target.kind === "thread" &&
    target.host !== undefined &&
    !connectedEnvironments.some(
      (environment) =>
        environment.environmentId === target.environmentId &&
        environment.connectionState === "connected",
    )
      ? target.host
      : null;
  const opensThread = target.kind === "thread" && unreachableHost === null;
  const action = props.onOpenTask
    ? "Open task"
    : target.kind !== "thread"
      ? target.label
      : unreachableHost !== null
        ? `Connect ${unreachableHost} to open`
        : "Open thread";
  const status = [card.statusLabel, card.attemptLabel, card.attentionLabel]
    .filter(Boolean)
    .join(" · ");
  const detailed = !props.onOpenTask;
  const closed = props.disabled === true || (!props.onOpenTask && !opensThread);
  const spokenStatus = props.statusHidden ? "" : ` ${status}.`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${card.title}.${spokenStatus}${detailed && card.continuationLabel ? ` ${card.continuationLabel}.` : ""}${detailed ? ` ${(card.evidenceLabels ?? []).join(". ")}` : ""} ${action}`}
      accessibilityState={{ disabled: closed }}
      disabled={closed}
      onPress={() => {
        if (props.onOpenTask) return props.onOpenTask();
        if (target.kind === "thread" && unreachableHost === null)
          props.onSelectThread({ environmentId: target.environmentId, id: target.threadId });
      }}
      className="min-h-[44px] gap-1 rounded-xl border border-border bg-card px-3 py-2.5"
    >
      {props.statusHidden ? null : (
        <View className="flex-row items-center gap-2">
          <View className={`h-2 w-2 rounded-full ${STATUS_DOT[card.tone]}`} />
          <Text
            className={card.tone === "danger" ? "text-danger-foreground" : "text-foreground-muted"}
            style={metaText}
          >
            {status}
          </Text>
        </View>
      )}
      <Text className="font-semibold text-foreground" style={titleText}>
        {card.title}
      </Text>
      {detailed
        ? [card.sourceLabel, card.continuationLabel].filter(Boolean).map((label) => (
            <Text key={label} className="text-foreground-muted" style={metaText}>
              {label}
            </Text>
          ))
        : null}
      {detailed && card.summary ? (
        <GoatBotTaskSummary
          summary={card.summary}
          environmentId={target.kind === "thread" ? target.environmentId : null}
          onSelectThread={props.onSelectThread}
        />
      ) : null}
      {detailed && card.pullRequests.length > 0 ? (
        <Text className="text-foreground-muted" style={metaText}>
          {"Pull requests: " + card.pullRequests.map((pullRequest) => pullRequest.label).join(", ")}
        </Text>
      ) : null}
      {detailed
        ? card.evidenceLabels?.map((label) => (
            <Text key={label} className="text-foreground-muted" style={metaText}>
              {label}
            </Text>
          ))
        : null}
      <Text
        className={closed ? "text-foreground-muted" : "font-medium text-foreground"}
        style={metaText}
      >
        {closed ? action : `${action} ›`}
      </Text>
    </Pressable>
  );
}

/** The row is the task's result, so a long summary opens in place instead of staying cut off. */
function GoatBotTaskSummary(props: {
  readonly summary: string;
  readonly environmentId: EnvironmentId | null;
  readonly onSelectThread: (thread: ThreadSelection) => void;
}) {
  const bodyText = useScaledTextRole("body");
  const metaText = useScaledTextRole("label");
  const [expanded, setExpanded] = useState(false);
  // Counted from the text: line metrics under numberOfLines differ between iOS and Android.
  const long =
    props.summary.length > SUMMARY_CHARS || props.summary.split("\n").length > SUMMARY_LINES;
  return (
    <View className="gap-0.5">
      {(expanded || !long) && hasGoatBotMarkdown(props.summary) ? (
        <GoatBotMarkdown
          text={props.summary}
          environmentId={props.environmentId}
          onSelectThread={props.onSelectThread}
        />
      ) : (
        // A collapsed long summary stays a bounded plain preview; the native renderer cannot clamp.
        <Text
          numberOfLines={expanded ? undefined : SUMMARY_LINES}
          className="text-foreground"
          style={bodyText}
        >
          <GoatBotLinkedText text={props.summary} />
        </Text>
      )}
      {long ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((open) => !open)}
          hitSlop={8}
        >
          <Text className="font-medium text-foreground-muted" style={metaText}>
            {expanded ? "Show less" : "Show more"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
