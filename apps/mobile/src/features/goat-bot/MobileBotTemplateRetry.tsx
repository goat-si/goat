import { botTemplateRetryInput } from "@goat/client-runtime/goatBot";
import type { BotProfile, ChannelBotResult, ChannelCreateBotInput } from "@goat/contracts";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

export function MobileBotTemplateRetry({
  bot,
  canRetry,
  retry,
}: {
  bot: BotProfile;
  canRetry: boolean;
  retry: (input: ChannelCreateBotInput) => Promise<ChannelBotResult | string>;
}) {
  const input = botTemplateRetryInput(bot);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string>();
  if (input === undefined || finished) return null;

  return (
    <View className="flex-row items-center justify-between gap-2">
      <Text accessibilityLiveRegion="polite" className="shrink text-sm text-foreground-muted">
        {error ?? "1 routine could not be added"}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Retry setup for ${bot.name}`}
        disabled={!canRetry || busy}
        className="min-h-11 justify-center px-2 disabled:opacity-50"
        onPress={async () => {
          setBusy(true);
          setError(undefined);
          const result = await retry(input);
          setBusy(false);
          if (typeof result === "string") setError(result);
          else if (!result.templateAutomationPending) setFinished(true);
        }}
      >
        <Text className="text-sm text-primary">{busy ? "Retrying…" : "Retry"}</Text>
      </Pressable>
    </View>
  );
}
