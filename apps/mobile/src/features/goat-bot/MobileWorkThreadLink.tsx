import { scopeThreadRef } from "@goat/client-runtime/environment";
import { botWorkerPullRequests, goatBotRowPullRequests } from "@goat/client-runtime/goatBot";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { useThreadShell } from "../../state/entities";
import { Pressable, Text } from "react-native";

/** A link to one of a task's work threads, held to the row's width so a long title truncates. */
export function MobileWorkThreadLink(props: {
  readonly link: { readonly text: string; readonly label: string };
  readonly disabled: boolean;
  readonly worker?: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  readonly fallbackPullRequests?: Parameters<typeof goatBotRowPullRequests>[0];
  /** The task screen mutes a closed link; Home's Show work keeps it underlined. */
  readonly mutedWhenDisabled?: boolean;
  readonly onPress: () => void;
}) {
  const shell = useThreadShell(
    props.worker ? scopeThreadRef(props.worker.environmentId, props.worker.threadId) : null,
  );
  const prs = goatBotRowPullRequests(
    shell?.pullRequests?.length
      ? botWorkerPullRequests(shell.pullRequests)
      : (props.fallbackPullRequests ?? {}),
    2,
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[props.link.label, ...prs.chips.map((chip) => chip.accessibleName)].join(
        ", ",
      )}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-[44px] max-w-full shrink justify-center"
    >
      <Text
        numberOfLines={1}
        className={
          props.disabled && props.mutedWhenDisabled
            ? "text-foreground-muted"
            : "text-foreground underline"
        }
      >
        {props.link.text}
      </Text>
      <MobileWorkPullRequests {...prs} />
    </Pressable>
  );
}

export function MobileWorkPullRequests({
  chips,
  moreLabel,
}: ReturnType<typeof goatBotRowPullRequests>) {
  if (chips.length === 0) return null;
  return (
    <Text
      className="text-xs text-foreground-muted"
      accessibilityLabel={[...chips.map((chip) => chip.accessibleName), moreLabel]
        .filter(Boolean)
        .join(", ")}
    >
      {chips.map((chip) => chip.text).join(" · ")}
      {moreLabel ? ` · ${moreLabel}` : ""}
    </Text>
  );
}
