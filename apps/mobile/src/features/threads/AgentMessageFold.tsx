import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentId, RemoteSenderAttribution, ThreadId } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Haptics from "expo-haptics";
import { Pressable, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useQuietThreadShell } from "../../state/entities";
import { usePreparedConnection } from "../../state/session";
import { ThreadDisclosureChevron } from "./thread-work-log";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

// A sender on another machine opens only through a connection this app holds to that machine.
function useOpenableRemoteSender(remoteSender: RemoteSenderAttribution | undefined) {
  const connection = usePreparedConnection(remoteSender?.environmentId ?? null);
  return remoteSender !== undefined && Option.isSome(connection) ? remoteSender : null;
}

/**
 * Names the thread that sent a message into this one, above its bubble. A thread this app holds
 * opens on tap, and so does one on another connected machine; a deleted, unknown or
 * disconnected one stays plain.
 */
export function AgentMessageSentByLabel(props: {
  readonly environmentId: EnvironmentId;
  readonly senderThreadId?: ThreadId | undefined;
  readonly remoteSender?: RemoteSenderAttribution | undefined;
}) {
  const remoteSender = props.senderThreadId ? undefined : props.remoteSender;
  const senderShell = useQuietThreadShell(
    props.senderThreadId ? scopeThreadRef(props.environmentId, props.senderThreadId) : null,
  );
  const openableRemote = useOpenableRemoteSender(remoteSender);
  const openLinkedThread = useOpenLinkedThread();
  const title = remoteSender?.title ?? (senderShell?.title.trim() || "Untitled thread");
  const label =
    senderShell === null && remoteSender === undefined
      ? "Sent from another thread"
      : `Sent by ${title} from another thread`;
  const className = "mb-1 pr-1 font-goat-medium text-2xs text-foreground-muted opacity-60";
  const target =
    openableRemote !== null
      ? {
          environmentId: String(openableRemote.environmentId),
          threadId: String(openableRemote.threadId),
        }
      : senderShell !== null && senderShell.deletedAt === null && props.senderThreadId
        ? { environmentId: String(props.environmentId), threadId: String(props.senderThreadId) }
        : null;
  if (target === null) {
    return (
      <Text
        numberOfLines={1}
        className={className}
        {...(remoteSender === undefined
          ? {}
          : { accessibilityHint: `Connect ${remoteSender.environmentLabel} to open this thread.` })}
      >
        {label}
      </Text>
    );
  }
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${title}`}
      hitSlop={6}
      onPress={() => openLinkedThread(target)}
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
  readonly senderThreadId?: ThreadId | undefined;
  readonly remoteSender?: RemoteSenderAttribution | undefined;
}) {
  const openLinkedThread = useOpenLinkedThread();
  const openableRemote = useOpenableRemoteSender(
    props.senderThreadId ? undefined : props.remoteSender,
  );
  const target = props.senderThreadId
    ? { environmentId: String(props.environmentId), threadId: String(props.senderThreadId) }
    : openableRemote !== null
      ? {
          environmentId: String(openableRemote.environmentId),
          threadId: String(openableRemote.threadId),
        }
      : null;
  if (target === null) return null;
  return (
    <Pressable accessibilityRole="link" hitSlop={6} onPress={() => openLinkedThread(target)}>
      <Text className="font-goat-medium text-xs text-foreground-secondary">Open thread</Text>
    </Pressable>
  );
}
