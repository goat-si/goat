import { AccessibilityInfo, Platform, Pressable, Text, View } from "react-native";
import { useEffect } from "react";

import type { NewBotOperation } from "./mobileNewBots";

/**
 * The roster's line for a New bot under way: Creating… until the server answers, the reason with
 * Retry and Dismiss when it failed, and the created bot until the list holds its own row.
 */
export function MobileNewBotStatus(props: {
  readonly operation: NewBotOperation;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
  readonly onOpen: () => void;
}) {
  const { operation } = props;
  const failure = operation.phase === "failed" ? operation.failure : null;
  const message = failure === null ? null : `Couldn't create a bot: ${failure}`;
  // oxlint-disable-next-line goat/react-effect-budget -- iOS has no live regions; VoiceOver hears why the create failed from here.
  useEffect(() => {
    if (message !== null && Platform.OS === "ios")
      AccessibilityInfo.announceForAccessibility(message);
  }, [message]);
  if (operation.phase === "creating")
    return (
      <View
        accessible
        accessibilityLabel={`${operation.name}, creating`}
        accessibilityState={{ busy: true }}
        className="min-h-[44px] justify-center px-4 py-3"
      >
        <Text className="text-foreground-muted">{`${operation.name} · Creating…`}</Text>
      </View>
    );
  if (operation.phase === "created")
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={operation.bot.name}
        onPress={props.onOpen}
        className="min-h-[44px] justify-center px-4 py-3"
      >
        <Text className="text-foreground">{operation.bot.name}</Text>
      </Pressable>
    );
  return (
    <View className="gap-1 px-4 py-2">
      <Text
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        className="text-danger-foreground"
      >
        {message}
      </Text>
      <View className="flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          onPress={props.onRetry}
          className="min-h-[44px] min-w-[44px] justify-center px-2"
        >
          <Text className="font-goat-medium text-primary-text">Retry</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={props.onDismiss}
          className="min-h-[44px] min-w-[44px] justify-center px-2"
        >
          <Text className="text-foreground-muted">Dismiss</Text>
        </Pressable>
      </View>
    </View>
  );
}
