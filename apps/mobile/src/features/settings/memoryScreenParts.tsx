import { MemoryOperationId } from "@goat/contracts";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import { AppText as Text } from "../../components/ui/AppText";
import { SettingsActionRow } from "./components/SettingsActionRow";

export const operationId = () => MemoryOperationId.make(Crypto.randomUUID());
export function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : "The request could not be completed.";
}
export function Copy({ children }: { readonly children: React.ReactNode }) {
  return (
    <Text selectable className="p-3 text-sm text-foreground-muted">
      {children}
    </Text>
  );
}
export function Action(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly tone?: "danger";
}) {
  return <SettingsActionRow icon="brain" {...props} />;
}
export function Field(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly multiline?: boolean;
}) {
  return (
    <View className="gap-2 p-3">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        editable={!props.disabled}
        multiline={props.multiline}
        className="rounded-lg border border-border p-3 text-foreground"
      />
    </View>
  );
}
