import { useEffect, useRef, useState } from "react";
import type { TextInputInstance } from "react-native";
import { AppTextInput } from "../../components/ui/AppText";

export function CustomAnswerInput(props: {
  readonly value: string;
  readonly multiline: boolean;
  readonly disabled: boolean;
  readonly onChangeText: (text: string) => void;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
}) {
  const inputRef = useRef<TextInputInstance>(null);
  const [initialText] = useState(props.value);
  const nativeText = useRef(props.value);
  // Preserve native autocorrection while applying an external clear.
  // oxlint-disable-next-line goat/react-effect-budget -- synchronize external clears with the native input
  useEffect(() => {
    if (props.value !== "" || nativeText.current === "") return;
    nativeText.current = "";
    inputRef.current?.clear();
  }, [props.value]);
  return (
    <AppTextInput
      ref={inputRef}
      defaultValue={initialText}
      multiline={props.multiline}
      submitBehavior={props.multiline ? "newline" : undefined}
      editable={!props.disabled}
      onChangeText={(text) => {
        nativeText.current = text;
        props.onChangeText(text);
      }}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      placeholder="Or type a custom answer"
      className="min-h-[54px] rounded-2xl border border-input-border bg-input px-3.5 py-3 font-sans text-base text-foreground"
    />
  );
}
