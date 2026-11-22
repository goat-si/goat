import type { BotProposalCard, ChannelResolveBotProposalInput } from "@goat/contracts";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

export function GoatBotProposalCard({
  card,
  resolve,
}: {
  readonly card: BotProposalCard;
  readonly resolve?: ((input: ChannelResolveBotProposalInput) => Promise<boolean>) | undefined;
}) {
  const [saving, setSaving] = useState(false);
  const [settled, setSettled] = useState<"accepted" | "dismissed">();
  const [now] = useState(Date.now);
  const expired = Date.parse(card.expiresAt) <= now;
  const status = settled ?? card.status;
  async function submit(accept: boolean) {
    if (!resolve) return;
    setSaving(true);
    try {
      if (await resolve({ proposalId: card.proposalId, accept })) {
        setSettled(accept ? "accepted" : "dismissed");
      }
    } finally {
      setSaving(false);
    }
  }
  return (
    <View className="my-2 gap-3 rounded-xl border border-border bg-card p-4">
      <Text accessibilityRole="header" className="font-semibold text-foreground">
        {card.fields.avatar} {card.fields.name}
      </Text>
      {card.fields.purpose ? <Text className="text-foreground">{card.fields.purpose}</Text> : null}
      <Text className="text-foreground-muted">{card.fields.why}</Text>
      {card.fields.instructions ? (
        <View>
          <Text className="font-semibold text-foreground">Instructions</Text>
          <Text className="text-foreground">{card.fields.instructions}</Text>
        </View>
      ) : null}
      {status === "pending" && !expired && resolve ? (
        <View className="flex-row gap-3">
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={() => void submit(true)}
            className="min-h-[44px] justify-center rounded-lg bg-primary px-4"
          >
            <Text className="font-semibold text-primary-foreground">Accept</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={() => void submit(false)}
            className="min-h-[44px] justify-center rounded-lg border border-border px-4"
          >
            <Text className="font-semibold text-foreground">Dismiss</Text>
          </Pressable>
        </View>
      ) : (
        <Text accessibilityLiveRegion="polite" className="text-foreground-muted">
          {status === "accepted"
            ? "Accepted"
            : status === "dismissed"
              ? "Dismissed"
              : expired
                ? "Expired"
                : "Awaiting review"}
        </Text>
      )}
    </View>
  );
}
