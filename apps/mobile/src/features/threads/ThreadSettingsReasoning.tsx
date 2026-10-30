import {
  isReasoningSliderDescriptor,
  REASONING_SELECT_DESCRIPTOR_IDS,
  reasoningSliderPosition,
} from "@goat/client-runtime/model-traits";
import type { ProviderOptionDescriptor } from "@goat/contracts";
import { getProviderOptionCurrentValue } from "@goat/shared/model";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SliderRow } from "../../components/ui/SliderRow";
import type { ThreadSettingsSessionValue } from "./thread-settings-session";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

export type ReasoningSlider = {
  readonly descriptor: SelectDescriptor;
  readonly index: number;
  readonly defaultIndex: number | null;
  /** "ultrathink" in the prompt body owns the level until the user removes it. */
  readonly promptLocked: boolean;
};

/** The displayed model's ordered reasoning option, or null when the list picker has to show it. */
export function resolveReasoningSlider(
  session: ThreadSettingsSessionValue,
): ReasoningSlider | null {
  const descriptor = session.displayedDescriptors.find(isReasoningSliderDescriptor);
  if (!descriptor) return null;
  const isPrimary = descriptor.id === session.promptTraits.primarySelectDescriptor?.id;
  const current =
    isPrimary && session.promptTraits.ultrathinkPromptControlled
      ? "ultrathink"
      : getProviderOptionCurrentValue(
          descriptor,
          session.displayedModelSelection,
          session.reportedModelSelection,
        );
  const position = reasoningSliderPosition(descriptor, current);
  if (!position) return null;
  return {
    descriptor,
    ...position,
    promptLocked: isPrimary && session.promptTraits.ultrathinkInBodyText,
  };
}

export function ThreadSettingsReasoning(props: {
  readonly session: ThreadSettingsSessionValue;
  readonly slider: ReasoningSlider | null;
}) {
  const slider = props.slider;
  if (!slider) {
    const hasReasoningOption = props.session.displayedDescriptors.some((descriptor) =>
      REASONING_SELECT_DESCRIPTOR_IDS.has(descriptor.id),
    );
    // Reasoning controls that are not an ordered ladder stay in Options.
    if (hasReasoningOption) return null;
    const model = props.session.displayedModel;
    const reason =
      model === null
        ? "Choose a model to see its reasoning levels."
        : model.capabilities === null
          ? `${model.label} has not reported its reasoning levels.`
          : `${model.label} doesn't offer reasoning levels.`;
    return (
      <View
        accessible
        accessibilityLabel={`Reasoning not available. ${reason}`}
        className="mx-4 mt-4 gap-1 rounded-2xl bg-grouped-card px-4 py-3"
      >
        <View className="flex-row items-center gap-2">
          <Text className="flex-1 text-base font-goat-medium text-foreground">Reasoning</Text>
          <Text className="text-sm text-foreground-muted">Not available</Text>
        </View>
        <Text className="text-xs text-foreground-muted">{reason}</Text>
      </View>
    );
  }

  const choices = slider.descriptor.options;
  const current = choices[slider.index];
  const defaultChoice = slider.defaultIndex === null ? undefined : choices[slider.defaultIndex];
  const valueLabel =
    (current?.label ?? "") + (slider.index === slider.defaultIndex ? " · Default" : "");
  const caption = slider.promptLocked
    ? 'Your prompt contains "ultrathink". Remove it to change reasoning.'
    : defaultChoice && slider.index !== slider.defaultIndex
      ? `Default: ${defaultChoice.label}`
      : null;

  return (
    <View className="mx-4 mt-4 overflow-hidden rounded-2xl bg-grouped-card">
      <SliderRow
        disabled={slider.promptLocked}
        icon="brain"
        label={slider.descriptor.label}
        valueLabel={valueLabel}
        min={0}
        max={choices.length - 1}
        step={1}
        value={slider.index}
        onChange={(index) => {
          const choice = choices[index];
          if (choice) props.session.applyOptionChange(slider.descriptor.id, choice.id);
        }}
      />
      <View className="-mt-2 flex-row items-start gap-2 px-4 pb-3">
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          className="text-xs text-foreground-muted"
        >
          {choices[0]?.label}
        </Text>
        <Text className="flex-1 text-center text-xs text-foreground-muted">{caption}</Text>
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          className="text-xs text-foreground-muted"
        >
          {choices[choices.length - 1]?.label}
        </Text>
      </View>
    </View>
  );
}
