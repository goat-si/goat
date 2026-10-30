import {
  durableDecisionAnswer,
  type DecisionItem,
} from "@goat/client-runtime/state/decision-inbox";
import type { DecisionAnswerInput } from "@goat/contracts";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

/** A decision an agent asked for: pick one option; the choice goes back to it. */
export function DecisionDurableCard(props: {
  readonly item: Extract<DecisionItem, { kind: "decision" }>;
  readonly draft: { readonly optionId: string | null } | undefined;
  readonly disabled: boolean;
  readonly responding: boolean;
  readonly onChange: (optionId: string) => void;
  readonly onSubmit: (answer: DecisionAnswerInput) => void;
}) {
  const { decision } = props.item;
  const optionId = props.draft?.optionId ?? decision.recommended;
  const chosen = decision.options.find((option) => option.id === optionId);
  const answer = optionId === null ? null : durableDecisionAnswer(decision, optionId);
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
          onPress={() => props.onChange(option.id)}
        />
      ))}
      {chosen?.consequence ? (
        <Text className="text-xs text-foreground-muted">{chosen.consequence}</Text>
      ) : null}
      <Button
        label={props.responding ? "Waiting for the decision to update…" : "Submit decision"}
        fullWidth
        tone="primary"
        disabled={props.disabled || props.responding || answer === null}
        onPress={() => {
          if (answer !== null) props.onSubmit(answer);
        }}
      />
    </View>
  );
}
