import type { NewBotOperation } from "@goat/client-runtime/goatBot";
import type { BotProfile } from "@goat/contracts";
import { useEffect } from "react";
import { AccessibilityInfo, Platform, Pressable, Text, View } from "react-native";

/**
 * The roster's lines for New bot: Creating… until the server answers, the reason with Retry and
 * Dismiss when it failed, and each created bot until the list holds its own row or it is dismissed.
 */
export function MobileNewBotStatus(props: {
  readonly operation: NewBotOperation | null;
  readonly created: ReadonlyArray<BotProfile>;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
  readonly onOpen: (bot: BotProfile) => void;
  readonly onDismissCreated: (bot: BotProfile) => void;
}) {
  const { operation } = props;
  const message =
    operation?.phase === "failed" ? `Couldn't create a bot: ${operation.failure}` : null;
  // oxlint-disable-next-line goat/react-effect-budget -- iOS has no live regions; VoiceOver hears why the create failed from here.
  useEffect(() => {
    if (message !== null && Platform.OS === "ios")
      AccessibilityInfo.announceForAccessibility(message);
  }, [message]);
  return (
    <View>
      {props.created.map((bot) => (
        <View key={bot.botId} className="flex-row items-center pr-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={bot.name}
            onPress={() => props.onOpen(bot)}
            className="min-h-[44px] flex-1 justify-center px-4 py-3"
          >
            <Text className="text-foreground">{bot.name}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Dismiss ${bot.name}`}
            onPress={() => props.onDismissCreated(bot)}
            className="min-h-[44px] min-w-[44px] justify-center px-2"
          >
            <Text className="text-foreground-muted">Dismiss</Text>
          </Pressable>
        </View>
      ))}
      {operation?.phase === "creating" ? (
        <View
          accessible
          accessibilityLabel={`${operation.name}, creating`}
          accessibilityState={{ busy: true }}
          className="min-h-[44px] justify-center px-4 py-3"
        >
          <Text className="text-foreground-muted">{`${operation.name} · Creating…`}</Text>
        </View>
      ) : null}
      {message !== null ? (
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
      ) : null}
    </View>
  );
}
