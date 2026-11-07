import { deriveGoatBotModelSettings } from "@goat/client-runtime/goatBot";
import type { EnvironmentId, ModelSelection } from "@goat/contracts";
import { Pressable, Text, View } from "react-native";

import { useEnvironmentServerConfig } from "../../state/entities";

/** A new bot's model: GOAT Bot's own until a person picks one of the ready models. */
export function MobileNewBotModel(props: {
  readonly environmentId: EnvironmentId;
  readonly model: ModelSelection | null;
  readonly onChange: (model: ModelSelection | null) => void;
}) {
  const config = useEnvironmentServerConfig(props.environmentId);
  if (!config) return null;
  const state = deriveGoatBotModelSettings({
    settings: config.settings,
    providers: config.providers,
  });
  const options = [
    { key: "same", label: "Same as GOAT Bot", subtitle: state.summaryLabel, selection: null },
    ...state.choices.map((choice) => ({
      key: choice.key,
      label: choice.label,
      subtitle: choice.providerLabel,
      selection: choice.selection,
    })),
  ];
  const selected = (selection: ModelSelection | null) =>
    selection === null
      ? props.model === null
      : props.model?.instanceId === selection.instanceId && props.model.model === selection.model;
  return (
    <View className="gap-1">
      <Text className="text-foreground">Model</Text>
      {options.map((option) => (
        <Pressable
          key={option.key}
          accessibilityRole="radio"
          accessibilityState={{ selected: selected(option.selection) }}
          onPress={() => props.onChange(option.selection)}
          className="min-h-[44px] flex-row items-center justify-between rounded-lg px-3 py-2"
        >
          <View className="min-w-0 flex-1">
            <Text className="text-foreground">{option.label}</Text>
            <Text numberOfLines={1} className="text-xs text-foreground-muted">
              {option.subtitle}
            </Text>
          </View>
          {selected(option.selection) ? <Text className="text-foreground">✓</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}
