import { useAtomValue } from "@effect/atom-react";
import { goatBotRowPullRequests, resolveRemoteBotWork } from "@goat/client-runtime/goatBot";
import type { BotRemoteWork, EnvironmentId, ThreadId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { Text, View } from "react-native";

import { channelEnvironment } from "../../state/channels";
import { MobileWorkPullRequests, MobileWorkThreadLink } from "./MobileWorkThreadLink";

const NOT_OPENABLE = Atom.make(false).pipe(Atom.withLabel("mobile-goat-bot-remote-work:none"));

/** A thread the bot launched on another machine: openable while this phone is connected there. */
export function MobileBotRemoteWork(props: {
  readonly item: BotRemoteWork;
  readonly onOpenThread: (thread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
  }) => void;
  /** Listed but closed, as when the bot's computer is offline. */
  readonly disabled?: boolean;
  /** Whether it opens, when the caller already knows (Home's shared value for current work). */
  readonly openable?: boolean;
}) {
  const { item } = props;
  const reachable = useAtomValue(
    item.environmentId === undefined
      ? NOT_OPENABLE
      : channelEnvironment.remoteWorkOpenable(item.environmentId),
  );
  const openable = props.openable ?? reachable;
  const target = resolveRemoteBotWork(
    item,
    (environmentId) => environmentId === item.environmentId && openable,
  );
  if (target.kind === "unavailable")
    return (
      <View className="min-w-0">
        <Text className="text-foreground-muted">{target.host} · Unavailable</Text>
        <MobileWorkPullRequests {...goatBotRowPullRequests(item, 2)} />
      </View>
    );
  const { ref } = target;
  return (
    <MobileWorkThreadLink
      worker={ref}
      fallbackPullRequests={item}
      link={{
        text: `Open work thread on ${target.host}`,
        label: `Open work thread on ${target.host}`,
      }}
      disabled={props.disabled === true}
      onPress={() => props.onOpenThread({ environmentId: ref.environmentId, id: ref.threadId })}
    />
  );
}
