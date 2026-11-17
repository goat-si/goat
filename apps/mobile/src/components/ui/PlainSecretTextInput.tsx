import { AppTextInput } from "./AppText";
import type { SecretTextInputProps } from "./SecretTextInput.types";

/** Masked field for a value that must stay out of password managers and suggestions. */
export function PlainSecretTextInput(props: SecretTextInputProps) {
  return (
    <AppTextInput
      accessibilityLabel={props.accessibilityLabel}
      placeholder={props.placeholder}
      value={props.value}
      onChangeText={props.onChangeText}
      editable={props.editable}
      onFocus={props.onFocus}
      secureTextEntry
      autoCorrect={false}
      autoCapitalize="none"
      autoComplete="off"
      textContentType="none"
      importantForAutofill="no"
      spellCheck={false}
      returnKeyType="done"
      onSubmitEditing={(event) => props.onSubmitEditing(event.nativeEvent.text)}
    />
  );
}
