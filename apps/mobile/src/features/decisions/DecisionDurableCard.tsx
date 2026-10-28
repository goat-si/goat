import type { DecisionItem } from "@goat/client-runtime/state/decision-inbox";
import { View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

/** A decision an agent asked for: pick one option and say why; the answer goes back to it. */
export function DecisionDurableCard(props: {
  readonly item: Extract<DecisionItem, { kind: "decision" }>;
  readonly draft: { readonly optionId: string | null; readonly reason: string } | undefined;
  readonly disabled: boolean;
  readonly responding: boolean;
  readonly onChange: (optionId: string | null, reason: string) => void;
  readonly onSubmit: (optionId: string, reason: string) => void;
}) {
  const { decision } = props.item;
  const optionId = props.draft?.optionId ?? decision.recommended;
  const reason = props.draft?.reason ?? "";
  const chosen = decision.options.find((option) => option.id === optionId);
  return (
    <View className="gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-goat-bold text-lg text-foreground">{decision.title}</Text>
      {decision.context ? (
        <Text className="text-sm text-foreground-muted">{decision.context}</Text>
      ) : null}
      {decision.options.map((option) => (
        <Button
          key={option.id}
          label={`${option.label}${decision.recommended === option.id ? " (recommended)" : ""}`}
          tone={optionId === option.id ? "primary" : "secondary"}
          selected={optionId === option.id}
          fullWidth
          disabled={props.disabled}
          onPress={() => props.onChange(option.id, reason)}
        />
      ))}
      {chosen?.consequence ? (
        <Text className="text-xs text-foreground-muted">{chosen.consequence}</Text>
      ) : null}
      <TextInput
        accessibilityLabel="Reason"
        value={reason}
        editable={!props.disabled}
        multiline
        placeholder="Why this choice? The agent sees it."
        onChangeText={(next) => props.onChange(optionId, next)}
        className="min-h-[54px] rounded-2xl border border-input-border bg-input px-3.5 py-3 font-sans text-base text-foreground"
      />
      <Button
        label={props.responding ? "Waiting for the decision to update…" : "Submit decision"}
        fullWidth
        tone="primary"
        disabled={props.disabled || props.responding || optionId === null || !reason.trim()}
        onPress={() => {
          if (optionId !== null && reason.trim()) props.onSubmit(optionId, reason.trim());
        }}
      />
    </View>
  );
}
