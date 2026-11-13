import { useAtomValue } from "@effect/atom-react";
import { retryRefusalText } from "@goat/client-runtime/goatBot";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";

export function MobileTaskRetry(props: {
  readonly environmentId: EnvironmentId;
  readonly taskId: ChannelTaskId;
  readonly onStarted: () => void;
  /** Offline the button stays, closed, and any problem it showed stays with it. */
  readonly disabled?: boolean;
}) {
  const canRetry = useAtomValue(channelEnvironment.retryTask.permissionAtom(props.environmentId));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!canRetry) return null;
  const run = async () => {
    if (busy || props.disabled) return;
    setBusy(true);
    setProblem(null);
    const result = await runAtomCommand(
      appAtomRegistry,
      channelEnvironment.retryTask,
      {
        environmentId: props.environmentId,
        input: { taskId: props.taskId, clientRequestId: uuidv4() },
      },
      { label: "GOAT Bot task retry", reportFailure: false },
    );
    setBusy(false);
    if (result._tag === "Success") {
      if (result.value.status === "refused") setProblem(retryRefusalText(result.value.reason));
      else props.onStarted();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setProblem(`Couldn't retry: ${failure instanceof Error ? failure.message : String(failure)}`);
  };
  return (
    <View className="gap-1">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy || props.disabled === true }}
        disabled={busy || props.disabled === true}
        onPress={() => void run()}
        className="min-h-[44px] justify-center"
      >
        <Text className="text-foreground">Retry</Text>
      </Pressable>
      {problem !== null ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {problem}
        </Text>
      ) : null}
    </View>
  );
}
