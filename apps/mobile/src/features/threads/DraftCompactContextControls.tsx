import type { ReactNode } from "react";
import { View } from "react-native";
import { ComposerInlineControl } from "../../components/ComposerToolbar";

export function DraftCompactContextControls(props: {
  readonly projectLabel: string;
  readonly disabled: boolean;
  readonly onChooseProject: () => void;
  readonly environmentControl: ReactNode;
}) {
  return (
    <View className="flex-row items-center gap-1 px-2">
      <View className="min-w-0 shrink">
        <ComposerInlineControl
          accessibilityHint="Opens the project picker"
          accessibilityLabel={`Project: ${props.projectLabel}`}
          chevronDirection="right"
          disabled={props.disabled}
          icon="folder"
          label={props.projectLabel}
          maxWidth="100%"
          onPress={props.onChooseProject}
        />
      </View>
      <View className="min-w-0 shrink">{props.environmentControl}</View>
    </View>
  );
}
