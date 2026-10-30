import {
  findReasoningDescriptor,
  getDescriptorStringValue,
  resolveEffortStepIndex,
} from "@goat/client-runtime/model-traits";
import type { ProviderOptionDescriptor } from "@goat/contracts";
import { getProviderOptionCurrentLabel } from "@goat/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { ProviderIcon } from "../../components/ProviderIcon";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { cn } from "../../lib/cn";
import { environmentServerConfigsAtom } from "../../state/server";
import { ChatGptSharingStatus } from "./ChatGptSharingStatus";
import { ReasoningStepSlider } from "./ReasoningStepSlider";
import { useThreadSettingsSession } from "./thread-settings-session";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

// Label and value wrap at word boundaries instead of truncating, so large text stays readable.
function OptionRow(props: {
  readonly label: string;
  readonly value: string;
  readonly isLast: boolean;
  readonly choices: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly description?: string | undefined;
  }>;
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <Menu
      title={props.label}
      actions={props.choices.map((choice) => ({
        id: choice.id,
        title: choice.label,
        ...(choice.description ? { subtitle: choice.description } : {}),
        state: choice.id === props.selectedId ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${props.value}`}
        className={cn(
          "min-h-11 flex-row flex-wrap items-center justify-between gap-x-3 gap-y-0.5 bg-grouped-card px-4 py-2 active:bg-subtle",
          !props.isLast && "border-b border-border-subtle",
        )}
      >
        <Text className="text-sm font-goat-medium text-foreground">{props.label}</Text>
        <View className="max-w-full flex-row items-center gap-1">
          <Text className="shrink text-sm text-foreground-muted">{props.value}</Text>
          <SymbolView
            name="chevron.down"
            size={11}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </View>
      </Pressable>
    </Menu>
  );
}

function SwitchOptionRow(props: {
  readonly label: string;
  readonly value: boolean;
  readonly isLast: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  return (
    <View
      className={cn(
        "min-h-11 flex-row items-center justify-between gap-3 bg-grouped-card px-4 py-1",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <Text className="shrink text-sm font-goat-medium text-foreground">{props.label}</Text>
      <ThemedSwitch
        accessibilityLabel={props.label}
        onValueChange={props.onValueChange}
        value={props.value}
      />
    </View>
  );
}

/**
 * The web composer's reasoning popover: the current step as the title, the model it applies to
 * (opens the model picker), and a slider over the model's steps. Remaining options sit below.
 */
export function ThreadSettingsTraits(props: { readonly onOpenModelPicker: () => void }) {
  const session = useThreadSettingsSession();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const selectedProvider = session.environmentId
    ? (configs
        .get(session.environmentId)
        ?.providers.find((provider) => provider.instanceId === session.providerInstanceId) ?? null)
    : null;
  const selects = session.descriptors.filter(
    (descriptor): descriptor is SelectDescriptor => descriptor.type === "select",
  );
  const reasoning = findReasoningDescriptor(selects);
  const primaryId = session.promptTraits.primarySelectDescriptor?.id;
  const selectedValue = (descriptor: SelectDescriptor) =>
    descriptor.id === primaryId && session.promptTraits.ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(
          descriptor,
          session.appliedModelSelection,
          session.reportedModelSelection,
        );
  const steps = reasoning?.options ?? [];
  const stepIndex = reasoning ? resolveEffortStepIndex(reasoning, selectedValue(reasoning)) : 0;
  const shownStep = steps[previewIndex ?? stepIndex];
  const reasoningLocked =
    reasoning !== null && reasoning.id === primaryId && session.promptTraits.ultrathinkInBodyText;
  const model = session.appliedModel;
  const modelLabel = model?.label ?? session.appliedModelSelection?.model ?? "Choose a model";
  const otherSelects = selects.filter((descriptor) => descriptor !== reasoning);
  const booleans = session.descriptors.filter((descriptor) => descriptor.type === "boolean");
  const selectChoice = (descriptor: SelectDescriptor, id: string) => {
    if (descriptor.id === primaryId && session.promptTraits.ultrathinkInBodyText) {
      Dialog.alert(
        "Reasoning controlled by prompt",
        'Your prompt contains "ultrathink" in the text. Remove it to change this option.',
      );
      return;
    }
    session.applyOptionChange(descriptor.id, id);
  };
  const runtimeLabel =
    session.runtimeModeChoices.find((choice) => choice.mode === session.runtimeMode)?.label ??
    session.runtimeMode;
  const optionCount = otherSelects.length + booleans.length + 1;

  return (
    <View className="gap-4 px-4 pb-2 pt-5">
      <View className="items-center gap-1">
        <View className="flex-row flex-wrap items-center justify-center gap-x-2 gap-y-1">
          <Text
            accessibilityRole="header"
            accessibilityLiveRegion="polite"
            className="text-center text-xl font-goat-bold text-primary"
          >
            {reasoning ? (shownStep?.label ?? "") : "Reasoning"}
          </Text>
          {reasoning && shownStep?.isDefault ? (
            <View className="rounded-md bg-subtle-strong px-1.5 py-0.5">
              <Text className="text-2xs font-goat-bold text-foreground-muted">Default</Text>
            </View>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Change model, current ${modelLabel}`}
          className="min-h-11 max-w-full flex-row items-center justify-center gap-1.5 px-2 active:opacity-60"
          onPress={props.onOpenModelPicker}
        >
          {model ? (
            <ProviderIcon
              iconUrl={model.providerIconUrl}
              provider={model.providerDriver}
              size={15}
            />
          ) : null}
          <Text className="shrink text-center text-sm text-foreground-muted">{modelLabel}</Text>
          <SymbolView
            name="chevron.right"
            size={12}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </Pressable>
      </View>

      {reasoning ? (
        <ReasoningStepSlider
          label={reasoning.label}
          steps={steps}
          index={stepIndex}
          disabled={reasoningLocked}
          onPreview={setPreviewIndex}
          onCommit={(index) => {
            const step = steps[index];
            if (step) session.applyOptionChange(reasoning.id, step.id);
          }}
        />
      ) : (
        <Text className="text-center text-sm text-foreground-muted">
          {model?.capabilities === null
            ? `${modelLabel} has not reported its reasoning levels.`
            : model || session.appliedModelSelection
              ? `${modelLabel} has no reasoning levels to choose from.`
              : "Choose a model to set its reasoning."}
        </Text>
      )}
      {reasoningLocked ? (
        <Text className="text-center text-xs text-foreground-muted">
          {`Your prompt contains "ultrathink" in the text. Remove it to change ${reasoning.label.toLowerCase()}.`}
        </Text>
      ) : null}

      <ChatGptSharingStatus provider={selectedProvider} />
      <View className="overflow-hidden rounded-2xl bg-grouped-card">
        {otherSelects.map((descriptor, index) => (
          <OptionRow
            key={descriptor.id}
            label={descriptor.label}
            value={
              getProviderOptionCurrentLabel(
                descriptor,
                session.appliedModelSelection,
                session.reportedModelSelection,
              ) ?? ""
            }
            isLast={index === optionCount - 1}
            choices={descriptor.options}
            selectedId={selectedValue(descriptor) ?? undefined}
            onSelect={(id) => selectChoice(descriptor, id)}
          />
        ))}
        {booleans.map((descriptor, index) =>
          descriptor.type === "boolean" ? (
            <SwitchOptionRow
              key={descriptor.id}
              label={descriptor.label}
              value={descriptor.currentValue ?? false}
              isLast={otherSelects.length + index === optionCount - 1}
              onValueChange={(value) => session.applyOptionChange(descriptor.id, value)}
            />
          ) : null,
        )}
        <OptionRow
          isLast
          label="Runtime"
          value={runtimeLabel}
          choices={session.runtimeModeChoices.map((choice) => ({
            id: choice.mode,
            label: choice.label,
            description: choice.description,
          }))}
          selectedId={session.runtimeMode}
          onSelect={(id) => {
            const choice = session.runtimeModeChoices.find((entry) => entry.mode === id);
            if (choice) session.onUpdateRuntimeMode(choice.mode);
          }}
        />
      </View>
    </View>
  );
}
