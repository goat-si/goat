import { STANDING_INSTRUCTIONS_MAX_CHARS, type ServerSettingsPatch } from "@t3tools/contracts";
import { useRef } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/AppText";
import { SettingsSection } from "./SettingsSection";

/** Dispatcher policy put in front of the first message of threads agents launch. */
export function StandingInstructionsSettings(props: {
  /** Null when the selected targets disagree. */
  instructions: string | null;
  disabled: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  const edited = useRef(false);
  return (
    <SettingsSection
      title="Standing instructions"
      trailing={
        props.instructions === null ? (
          <Text className="text-xs text-foreground-muted">Mixed</Text>
        ) : null
      }
    >
      <View className="gap-2 px-4 py-3">
        <Text className="text-sm text-foreground-muted">
          Put in front of the first message of every thread an agent launches here. Projects can
          replace them.
        </Text>
        <AppTextInput
          key={props.instructions}
          accessibilityLabel="Standing instructions"
          onChangeText={() => {
            edited.current = true;
          }}
          defaultValue={props.instructions ?? ""}
          placeholder={
            props.instructions === null
              ? "Mixed. Enter instructions for all selected targets."
              : "Use sol for subagents. One topic per PR."
          }
          editable={!props.disabled}
          multiline
          maxLength={STANDING_INSTRUCTIONS_MAX_CHARS}
          autoCapitalize="sentences"
          className="min-h-24 rounded-xl px-3 py-2 text-base text-foreground"
          onEndEditing={(event) => {
            const value = event.nativeEvent.text.trim();
            if (
              !props.disabled &&
              edited.current &&
              (props.instructions === null || value !== props.instructions)
            )
              props.onChange({ standingInstructions: value });
            edited.current = false;
          }}
        />
      </View>
    </SettingsSection>
  );
}
