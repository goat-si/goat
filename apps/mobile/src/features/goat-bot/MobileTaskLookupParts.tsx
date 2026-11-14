import { isRetryableTaskStatus } from "@goat/client-runtime/goatBot";
import type { BotWorkResult, EnvironmentId, ThreadId } from "@goat/contracts";
import { Pressable, Text, View } from "react-native";

import { MobileBotRemoteWork } from "./MobileBotRemoteWork";
import { MobileTaskRetry } from "./MobileTaskRetry";

type Unavailable = Extract<BotWorkResult["task"], { readonly state: "unavailable" }>;
type OpenThread = (thread: { environmentId: EnvironmentId; id: ThreadId }) => void;

/** What the looked-up result says it left out, for a task whose state is known or not. */
export function MobileTaskLookupNotices(props: { readonly result: BotWorkResult }) {
  return (
    <>
      {props.result.launchesTruncated ? (
        <Text className="text-foreground-muted">More of this task's work isn't shown here.</Text>
      ) : null}
      {props.result.partial ? (
        <Text className="text-foreground-muted">Some task details could not be checked.</Text>
      ) : null}
    </>
  );
}

/**
 * A looked-up task whose read, pinned and done state the server could not read: its work and
 * Retry, with nothing that depends on that state.
 */
export function MobileTaskUnavailable(props: {
  readonly task: Unavailable;
  readonly result: BotWorkResult;
  readonly environmentId: EnvironmentId | null;
  readonly enabled: boolean;
  readonly canRetry: boolean;
  readonly onRetried: () => void;
  readonly onOpenThread: OpenThread;
}) {
  const closed = !props.enabled;
  const threads = new Map<string, { environmentId: EnvironmentId; threadId: ThreadId }>();
  for (const thread of [props.task.worker, ...props.result.codingRows]) {
    if (thread !== undefined)
      threads.set(JSON.stringify([thread.environmentId, thread.threadId]), thread);
  }
  return (
    <View className="gap-2">
      <Text className="text-foreground-muted">
        Its read, pinned and done state couldn't be read.
      </Text>
      <View className="flex-row flex-wrap gap-3">
        {props.environmentId && props.canRetry && isRetryableTaskStatus(props.task.task.status) ? (
          <MobileTaskRetry
            environmentId={props.environmentId}
            taskId={props.task.task.taskId}
            onStarted={props.onRetried}
            disabled={closed}
          />
        ) : null}
        {[...threads].map(([key, thread]) => (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityState={{ disabled: closed }}
            disabled={closed}
            className="min-h-[44px] justify-center"
            onPress={() =>
              props.onOpenThread({ environmentId: thread.environmentId, id: thread.threadId })
            }
          >
            <Text className={closed ? "text-foreground-muted" : "text-foreground underline"}>
              Open work thread
            </Text>
          </Pressable>
        ))}
        {props.result.remoteWork.map((item) => (
          <MobileBotRemoteWork
            key={item.childWorkId}
            item={item}
            onOpenThread={props.onOpenThread}
            disabled={closed}
          />
        ))}
      </View>
    </View>
  );
}
