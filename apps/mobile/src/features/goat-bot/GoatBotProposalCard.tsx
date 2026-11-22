import { useAtomValue } from "@effect/atom-react";
import { botManageFailure } from "@goat/client-runtime/goatBot";
import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotProposalCard, EnvironmentId } from "@goat/contracts";
import { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useGoatBotComputerConnected } from "./goatBotComputerLink";

export function GoatBotProposalCard({
  card,
  environmentId,
}: {
  readonly card: BotProposalCard;
  readonly environmentId: EnvironmentId;
}) {
  const config = useEnvironmentServerConfig(environmentId);
  const connected = useGoatBotComputerConnected(environmentId);
  const permitted = useAtomValue(
    channelEnvironment.resolveBotProposal.permissionAtom(environmentId),
  );
  const [saving, setSaving] = useState(false);
  const [settled, setSettled] = useState<"accepted" | "dismissed">();
  const [now] = useState(Date.now);
  const expired = Date.parse(card.expiresAt) <= now;
  const status = settled ?? card.status;
  const canResolve =
    connected && permitted && config?.environment.capabilities.goatBotProposals === true;
  async function submit(accept: boolean) {
    setSaving(true);
    try {
      const result = await runAtomCommand(appAtomRegistry, channelEnvironment.resolveBotProposal, {
        environmentId,
        input: { proposalId: card.proposalId, accept },
      });
      if (result._tag === "Success") setSettled(accept ? "accepted" : "dismissed");
      else
        Alert.alert(
          "Couldn't resolve proposal",
          botManageFailure(squashAtomCommandFailure(result)),
        );
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
      {status === "pending" && !expired && canResolve ? (
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
