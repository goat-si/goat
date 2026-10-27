import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Haptics from "expo-haptics";
import { Pressable, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useQuietThreadShell } from "../../state/entities";
import { ThreadDisclosureChevron } from "./thread-work-log";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

/**
 * Names the thread that sent a message into this one, above its bubble. A thread this app holds
 * opens on tap; a deleted or unknown one stays plain.
 */
export function AgentMessageSentByLabel(props: {
  readonly environmentId: EnvironmentId;
  readonly senderThreadId?: ThreadId | undefined;
}) {
  const senderShell = useQuietThreadShell(
    props.senderThreadId ? scopeThreadRef(props.environmentId, props.senderThreadId) : null,
  );
  const openLinkedThread = useOpenLinkedThread();
  const title = senderShell?.title.trim() || "Untitled thread";
  const label =
    senderShell === null ? "Sent from another thread" : `Sent by ${title} from another thread`;
  const className = "mb-1 pr-1 font-goat-medium text-2xs text-foreground-muted opacity-60";
  if (senderShell === null || senderShell.deletedAt !== null || !props.senderThreadId) {
    return (
      <Text numberOfLines={1} className={className}>
        {label}
      </Text>
    );
  }
  const senderThreadId = props.senderThreadId;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${title}`}
      hitSlop={6}
      onPress={() =>
        openLinkedThread({
          environmentId: String(props.environmentId),
          threadId: String(senderThreadId),
        })
      }
    >
      <Text numberOfLines={1} className={className}>
        {label}
      </Text>
    </Pressable>
  );
}

export function AgentMessageFoldHeader(props: {
  readonly summary: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly iconSubtleColor: ColorValue;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.summary || "Message from another thread"}
      accessibilityHint={`Double tap to ${props.expanded ? "hide" : "show"} the message.`}
      accessibilityState={{ expanded: props.expanded }}
      hitSlop={4}
      className="min-h-10 flex-row items-center gap-1.5 px-3.5 py-2"
      onPress={() => {
        void Haptics.selectionAsync();
        props.onToggle();
      }}
    >
      <SymbolView
        name="bubble.left.and.bubble.right"
        size={14}
        weight="medium"
        tintColorClassName="accent-user-bubble-foreground-muted"
        type="monochrome"
      />
      <Text numberOfLines={1} className="min-w-0 shrink text-sm text-user-bubble-foreground">
        {props.summary}
      </Text>
      <ThreadDisclosureChevron
        expanded={props.expanded}
        collapsedDirection="down"
        size={11}
        tintColor={props.iconSubtleColor}
      />
    </Pressable>
  );
}

export function OpenSenderThreadButton(props: {
  readonly environmentId: EnvironmentId;
  readonly senderThreadId: ThreadId;
}) {
  const openLinkedThread = useOpenLinkedThread();
  return (
    <Pressable
      accessibilityRole="link"
      hitSlop={6}
      onPress={() =>
        openLinkedThread({
          environmentId: String(props.environmentId),
          threadId: String(props.senderThreadId),
        })
      }
    >
      <Text className="font-goat-medium text-xs text-foreground-secondary">Open thread</Text>
    </Pressable>
  );
}
