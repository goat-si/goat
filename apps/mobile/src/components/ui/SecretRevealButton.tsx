import { Pressable } from "react-native";

import { SymbolView } from "./AppSymbol";

/** Eye toggle that shows or hides a secret field's typed text. */
export function SecretRevealButton(props: {
  readonly revealed: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true }}
      accessibilityLabel={props.revealed ? "Hide secret" : "Show secret"}
      className="size-10 items-center justify-center"
    >
      <SymbolView
        name={props.revealed ? "eye.slash" : "eye"}
        size={18}
        tintColorClassName="accent-icon-muted"
      />
    </Pressable>
  );
}
