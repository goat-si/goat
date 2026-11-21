import { BOT_TASK_SNOOZE_CHOICES } from "@goat/client-runtime/goatBot";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

export function MobileTaskSnooze(props: {
  readonly snoozed: boolean;
  readonly disabled: boolean;
  readonly onChange: (choice: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: props.disabled, ...(props.snoozed ? {} : { expanded }) }}
        disabled={props.disabled}
        className="min-h-[44px] justify-center"
        onPress={() => {
          if (props.snoozed) props.onChange("unsnooze");
          else setExpanded((value) => !value);
        }}
      >
        <Text className={props.disabled ? "text-foreground-muted" : "text-foreground"}>
          {props.snoozed ? "Unsnooze" : "Snooze"}
        </Text>
      </Pressable>
      {expanded &&
        !props.snoozed &&
        !props.disabled &&
        BOT_TASK_SNOOZE_CHOICES.map((choice) => (
          <Pressable
            key={choice.id}
            accessibilityRole="button"
            className="min-h-[44px] justify-center"
            onPress={() => {
              setExpanded(false);
              props.onChange(choice.id);
            }}
          >
            <Text className="text-foreground">{choice.label}</Text>
          </Pressable>
        ))}
    </View>
  );
}
