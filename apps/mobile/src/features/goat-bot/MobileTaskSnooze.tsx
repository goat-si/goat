import { BOT_TASK_SNOOZE_CHOICES } from "@goat/client-runtime/goatBot";
import { Pressable, Text } from "react-native";
import { MobileBotRowMenu } from "./MobileBotRowMenu";

const snoozeActions = BOT_TASK_SNOOZE_CHOICES.map(({ id, label }) => ({ id, title: label }));

export function MobileTaskSnooze(props: {
  readonly snoozed: boolean;
  readonly disabled: boolean;
  readonly onChange: (choice: string) => void;
}) {
  if (!props.snoozed && !props.disabled) {
    return (
      <MobileBotRowMenu
        label="Snooze"
        title="Snooze"
        triggerText="Snooze"
        actions={snoozeActions}
        onSelect={props.onChange}
      />
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      className="min-h-[44px] justify-center"
      onPress={() => props.onChange("unsnooze")}
    >
      <Text className={props.disabled ? "text-foreground-muted" : "text-foreground"}>
        {props.snoozed ? "Unsnooze" : "Snooze"}
      </Text>
    </Pressable>
  );
}
