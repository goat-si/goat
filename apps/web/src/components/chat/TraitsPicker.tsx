import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  getTraitSelectChange,
  replaceDescriptorCurrentValue,
  selectableProviderOptionChoices,
  REASONING_SELECT_DESCRIPTOR_IDS,
  ULTRATHINK_PROMPT_PREFIX,
} from "@goat/client-runtime/model-traits";
import {
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@goat/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
  normalizeModelSlug,
} from "@goat/shared/model";
import { memo, useRef } from "react";
import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { BrainIcon, ChevronRightIcon } from "~/components/solar";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  type ComposerControlSize,
} from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { getTriggerDisplayModelName } from "./providerIconUtils";
import { useComposerMenuState } from "./useComposerMenuState";

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

/**
 * All the picker reads from the prompt while rendering. Passing this instead of
 * the prompt keeps the picker from re-rendering on every keystroke.
 */
export type PromptUltrathink = "none" | "prefix" | "body";

export function readPromptUltrathink(prompt: string): PromptUltrathink {
  if (!isClaudeUltrathinkPrompt(prompt)) return "none";
  return isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, "")) ? "body" : "prefix";
}

const SAVED_OPTION_LABELS: Readonly<Record<string, string>> = {
  agent: "Agent",
  effort: "Effort",
  reasoningEffort: "Reasoning effort",
  variant: "Reasoning",
};

function savedOptionLabel(id: string): string {
  return (
    SAVED_OPTION_LABELS[id] ??
    id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase())
  );
}

function buildUnavailableModelOptionDescriptors(
  selections: ProviderOptions | null | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return (selections ?? []).map((selection) =>
    typeof selection.value === "boolean"
      ? {
          id: selection.id,
          label: savedOptionLabel(selection.id),
          type: "boolean" as const,
          currentValue: selection.value,
        }
      : {
          id: selection.id,
          label: savedOptionLabel(selection.id),
          type: "select" as const,
          options: [{ id: selection.value, label: selection.value }],
          currentValue: selection.value,
        },
  );
}

type TraitsPersistence =
  | {
      threadRef?: ScopedThreadRef;
      draftId?: DraftId;
      onModelOptionsChange?: never;
    }
  | {
      threadRef?: undefined;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

function DefaultBadge() {
  return (
    <Badge variant="outline" size="sm" className="min-w-0">
      Default
    </Badge>
  );
}

function getSelectedTraits(
  provider: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  promptUltrathink: PromptUltrathink,
  modelOptions: ProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
  planModeEnabled: boolean,
) {
  const caps = getProviderModelCapabilities(models, model, provider, planModeEnabled);
  const modelIsUnavailable =
    provider === "opencode" &&
    !models.some((candidate) => candidate.slug === normalizeModelSlug(model, provider));
  const descriptors = modelIsUnavailable
    ? buildUnavailableModelOptionDescriptors(
        planModeEnabled
          ? modelOptions
          : modelOptions?.filter((option) => option.id !== "agent" || option.value !== "plan"),
      )
    : getProviderOptionDescriptors({
        caps,
        selections: modelOptions,
      });
  const selectDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select",
  );
  const booleanDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "boolean" }> =>
      descriptor.type === "boolean",
  );
  const primarySelectDescriptor = selectDescriptors[0] ?? null;
  const contextWindowDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === "contextWindow") ?? null;
  const agentDescriptor = selectDescriptors.find((descriptor) => descriptor.id === "agent") ?? null;
  const fastModeDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const thinkingDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "thinking") ?? null;

  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    promptUltrathink !== "none";
  const ultrathinkInBodyText = ultrathinkPromptControlled && promptUltrathink === "body";
  const effort =
    (ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(primarySelectDescriptor)) ?? null;
  const thinkingEnabled =
    typeof thinkingDescriptor?.currentValue === "boolean" ? thinkingDescriptor.currentValue : null;
  const contextWindow = getDescriptorStringValue(contextWindowDescriptor);
  const selectedAgent = getDescriptorStringValue(agentDescriptor);
  const selectedAgentLabel = agentDescriptor
    ? getProviderOptionCurrentLabel(agentDescriptor)
    : null;

  return {
    caps,
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    contextWindowDescriptor,
    agentDescriptor,
    fastModeDescriptor,
    thinkingDescriptor,
    effort,
    thinkingEnabled,
    contextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    selectedAgent,
    selectedAgentLabel,
    modelIsUnavailable,
  };
}

function getTraitsSectionVisibility(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  promptUltrathink?: PromptUltrathink | undefined;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  planModeEnabled: boolean;
}) {
  const selected = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    input.promptUltrathink ?? "none",
    input.modelOptions,
    input.allowPromptInjectedEffort ?? true,
    input.planModeEnabled,
  );

  const showEffort = selected.primarySelectDescriptor !== null;
  const showThinking = selected.thinkingDescriptor !== null;
  const showFastMode = selected.fastModeDescriptor !== null;
  const showContextWindow = selected.contextWindowDescriptor !== null;
  const showAgent = selected.agentDescriptor !== null;

  return {
    ...selected,
    showEffort,
    showThinking,
    showFastMode,
    showContextWindow,
    showAgent,
    hasAnyControls:
      showEffort ||
      showThinking ||
      showFastMode ||
      showContextWindow ||
      showAgent ||
      (selected.modelIsUnavailable && selected.descriptors.length > 0),
  };
}

/**
 * `modelOptions` must already carry the composer's implicit defaults (see
 * `withImplicitFastModeDefault`) so the persisted selection matches what the
 * picker would write.
 */
export function getReasoningTraitStep(input: {
  provider: ProviderDriverKind;
  instanceId: ProviderInstanceId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderOptions | undefined;
  reportedModelSelection: ModelSelection | null | undefined;
  prompt: string;
  planModeEnabled: boolean;
  direction: 1 | -1;
}) {
  const selected = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    readPromptUltrathink(input.prompt),
    input.modelOptions,
    true,
    input.planModeEnabled,
  );
  if (selected.modelIsUnavailable || selected.ultrathinkInBodyText) return null;
  const descriptor = selected.selectDescriptors.find((entry) =>
    REASONING_SELECT_DESCRIPTOR_IDS.has(entry.id),
  );
  if (!descriptor || descriptor.options.length < 2) return null;
  const isPrimary = descriptor.id === selected.primarySelectDescriptor?.id;
  const current =
    isPrimary && selected.ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(
          descriptor,
          { instanceId: input.instanceId, model: input.model, options: input.modelOptions ?? [] },
          input.reportedModelSelection,
        );
  const ordered = input.direction > 0 ? descriptor.options : descriptor.options.toReversed();
  // A reported value outside the catalog, such as OpenCode's "default", steps
  // from the catalog default, or from the end when there is none.
  const position =
    [current, getDescriptorStringValue(descriptor)]
      .map((value) => ordered.findIndex((option) => option.id === value))
      .find((index) => index >= 0) ?? -1;
  for (const option of [
    ...ordered.slice(position + 1),
    ...ordered.slice(0, Math.max(position, 0)),
  ]) {
    const change = getTraitSelectChange(selected, descriptor, input.prompt, option.id);
    if (!change) return null;
    if ("modelOptions" in change) {
      return change.modelOptions
        ? { prompt: change.prompt, modelOptions: change.modelOptions }
        : null;
    }
    // A slash command refuses the Ultrathink prefix, so skip that level.
    if (change.prompt.startsWith(ULTRATHINK_PROMPT_PREFIX)) return change;
  }
  return null;
}

export function shouldRenderTraitsControls(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  promptUltrathink?: PromptUltrathink | undefined;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  planModeEnabled: boolean;
}): boolean {
  return getTraitsSectionVisibility(input).hasAnyControls;
}

export interface TraitsMenuContentProps {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  promptUltrathink?: PromptUltrathink | undefined;
  /** Receives an edit of the live prompt; the picker never holds the prompt text itself. */
  onPromptEdit?: (edit: (prompt: string) => string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
  allowPromptInjectedEffort?: boolean;
  planModeEnabled: boolean;
  triggerClassName?: string;
  isComposerOwned?: boolean;
  /** Composer only: the effort popover's model row reopens the model picker. */
  onOpenModelPicker?: () => void;
}

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

/** The reasoning select the composer's effort slider drives, or null when the model has none. */
export function findReasoningDescriptor(
  selectDescriptors: ReadonlyArray<SelectDescriptor>,
): SelectDescriptor | null {
  return (
    selectDescriptors.find(
      (descriptor) =>
        REASONING_SELECT_DESCRIPTOR_IDS.has(descriptor.id) && descriptor.options.length > 1,
    ) ?? null
  );
}

/** The slider step for a selected value, falling back to the provider default, then the first. */
export function resolveEffortStepIndex(
  descriptor: SelectDescriptor,
  selectedValue: string | null,
): number {
  const selected = descriptor.options.findIndex((option) => option.id === selectedValue);
  if (selected >= 0) return selected;
  return Math.max(
    0,
    descriptor.options.findIndex((option) => option.isDefault),
  );
}

/** Shared selection state and writers for the traits menu and the composer effort popover. */
function useTraitsController({
  provider,
  instanceId,
  models,
  model,
  promptUltrathink,
  onPromptEdit,
  modelOptions,
  reportedModelSelection,
  allowPromptInjectedEffort = true,
  planModeEnabled,
  persistence,
}: Omit<TraitsMenuContentProps, "triggerClassName" | "isComposerOwned" | "onOpenModelPicker"> & {
  persistence: TraitsPersistence;
}) {
  const modelSelection =
    instanceId && model ? { instanceId, model, options: modelOptions ?? [] } : null;
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const updateModelOptions = (nextOptions: ProviderOptions | undefined) => {
    if ("onModelOptionsChange" in persistence) {
      persistence.onModelOptionsChange(nextOptions);
      return;
    }
    const threadTarget = persistence.threadRef ?? persistence.draftId;
    if (!threadTarget) {
      return;
    }
    setProviderModelOptions(threadTarget, provider, nextOptions, {
      ...(instanceId ? { instanceId } : {}),
      model,
      persistSticky: true,
    });
  };
  const visibility = getTraitsSectionVisibility({
    provider,
    models,
    model,
    promptUltrathink,
    modelOptions,
    allowPromptInjectedEffort,
    planModeEnabled,
  });
  const { descriptors, primarySelectDescriptor, ultrathinkPromptControlled, ultrathinkInBodyText } =
    visibility;
  const updateDescriptors = (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => {
    updateModelOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors));
  };

  const handleSelectChange = (descriptor: SelectDescriptor, value: string) => {
    // Whether a pick applies, and the options it writes, do not depend on the prompt text.
    const change = getTraitSelectChange(visibility, descriptor, "", value);
    if (!change) return;
    onPromptEdit?.(
      (prompt) => getTraitSelectChange(visibility, descriptor, prompt, value)?.prompt ?? prompt,
    );
    if ("modelOptions" in change) updateModelOptions(change.modelOptions);
  };
  const handleBooleanChange = (descriptorId: string, value: boolean) => {
    updateDescriptors(replaceDescriptorCurrentValue(descriptors, descriptorId, value));
  };
  /** The selected value, reading prompt-controlled ultrathink back into the primary select. */
  const selectedSelectValue = (descriptor: SelectDescriptor) =>
    ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id
      ? "ultrathink"
      : getDescriptorStringValue(descriptor, modelSelection, reportedModelSelection);
  /** Body text that says "ultrathink" pins the primary select until the user removes it. */
  const isSelectLocked = (descriptor: SelectDescriptor) =>
    ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id;

  return {
    ...visibility,
    modelSelection,
    handleSelectChange,
    handleBooleanChange,
    selectedSelectValue,
    isSelectLocked,
  };
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  instanceId,
  models,
  model,
  promptUltrathink,
  onPromptEdit,
  modelOptions,
  reportedModelSelection,
  allowPromptInjectedEffort = true,
  planModeEnabled,
  triggerClassName: _triggerClassName,
  isComposerOwned: _isComposerOwned,
  onOpenModelPicker: _onOpenModelPicker,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const {
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    hasAnyControls,
    modelIsUnavailable,
    modelSelection,
    handleSelectChange,
    handleBooleanChange,
    selectedSelectValue,
    isSelectLocked,
  } = useTraitsController({
    provider,
    ...(instanceId ? { instanceId } : {}),
    models,
    model,
    promptUltrathink,
    ...(onPromptEdit ? { onPromptEdit } : {}),
    modelOptions,
    reportedModelSelection,
    allowPromptInjectedEffort,
    planModeEnabled,
    persistence,
  });

  if (!hasAnyControls) {
    return null;
  }

  if (modelIsUnavailable) {
    return (
      <>
        {descriptors.map((descriptor, index) => {
          const value = getProviderOptionCurrentLabel(
            descriptor,
            modelSelection,
            reportedModelSelection,
          );
          if (!value) return null;
          return (
            <div key={descriptor.id}>
              {index > 0 ? <MenuDivider /> : null}
              <MenuGroup>
                <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
                  {descriptor.label}
                </div>
                <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">{value}</div>
              </MenuGroup>
            </div>
          );
        })}
      </>
    );
  }

  return (
    <>
      {selectDescriptors.map((descriptor, index) => {
        const selectedValue = selectedSelectValue(descriptor) ?? "";

        return (
          <div key={descriptor.id}>
            {index > 0 ? <MenuDivider /> : null}
            <MenuGroup>
              <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
                {descriptor.label}
              </div>
              {isSelectLocked(descriptor) ? (
                <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                  Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change this
                  option.
                </div>
              ) : null}
              <MenuRadioGroup
                value={selectedValue}
                onValueChange={(value) => handleSelectChange(descriptor, value)}
              >
                {selectableProviderOptionChoices(descriptor).map((option) => (
                  <MenuRadioItem
                    key={option.id}
                    value={option.id}
                    hideIndicator
                    // Base UI keeps radio menus open by default. Close on pick so
                    // the traits menu behaves like the model picker.
                    closeOnClick
                    disabled={isSelectLocked(descriptor)}
                  >
                    <span className="flex w-full min-w-0 flex-col">
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="min-w-0 truncate">{option.label}</span>
                        {option.isDefault ? <DefaultBadge /> : null}
                      </span>
                      {option.description ? (
                        <span className="max-w-56 text-pretty text-muted-foreground/80 text-xs">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </div>
        );
      })}
      {booleanDescriptors.map((descriptor, index) => {
        const selectedValue = descriptor.currentValue === true ? "on" : "off";

        return (
          <div key={descriptor.id}>
            {index > 0 || selectDescriptors.length > 0 ? <MenuDivider /> : null}
            <MenuGroup>
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                {descriptor.label}
              </div>
              <MenuRadioGroup
                value={selectedValue}
                onValueChange={(value) => {
                  handleBooleanChange(descriptor.id, value === "on");
                }}
              >
                {(["on", "off"] as const).map((value) => (
                  <MenuRadioItem key={value} value={value} hideIndicator closeOnClick>
                    <span className="flex w-full min-w-0 items-center justify-between gap-3">
                      <span>{value === "on" ? "On" : "Off"}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </div>
        );
      })}
    </>
  );
});

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  instanceId,
  models,
  model,
  promptUltrathink,
  onPromptEdit,
  modelOptions,
  reportedModelSelection,
  allowPromptInjectedEffort = true,
  planModeEnabled,
  triggerClassName,
  isComposerOwned,
  onOpenModelPicker,
  size = "sm",
  hidden = false,
  disabled = false,
  ...persistence
}: TraitsMenuContentProps &
  TraitsPersistence & {
    size?: ComposerControlSize;
    hidden?: boolean;
    disabled?: boolean;
  }) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [isMenuOpen, setIsMenuOpen] = useComposerMenuState(hidden || disabled);
  const { descriptors, primarySelectDescriptor, ultrathinkPromptControlled } =
    getTraitsSectionVisibility({
      provider,
      models,
      model,
      promptUltrathink,
      modelOptions,
      allowPromptInjectedEffort,
      planModeEnabled,
    });
  if (
    !shouldRenderTraitsControls({
      provider,
      models,
      model,
      promptUltrathink,
      modelOptions,
      allowPromptInjectedEffort,
      planModeEnabled,
    })
  ) {
    return null;
  }

  const { label: triggerLabel } = buildTraitsTriggerDisplay({
    provider,
    descriptors,
    primarySelectDescriptorId: primarySelectDescriptor?.id ?? null,
    ultrathinkPromptControlled,
    modelSelection: instanceId && model ? { instanceId, model, options: modelOptions ?? [] } : null,
    reportedModelSelection,
  });
  const isCodexStyle = provider === "codex";

  if (isComposerOwned) {
    return (
      <ComposerTraitsPicker
        traitsInput={{
          provider,
          ...(instanceId ? { instanceId } : {}),
          models,
          model,
          promptUltrathink,
          ...(onPromptEdit ? { onPromptEdit } : {}),
          modelOptions,
          reportedModelSelection,
          allowPromptInjectedEffort,
          planModeEnabled,
          persistence,
        }}
        triggerLabel={triggerLabel}
        size={size}
        hidden={hidden}
        disabled={disabled}
        {...(triggerClassName !== undefined ? { triggerClassName } : {})}
        {...(onOpenModelPicker ? { onOpenModelPicker } : {})}
      />
    );
  }

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open && !disabled);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  disabled={disabled}
                  aria-label={triggerLabel}
                  data-composer-shortcut={isComposerOwned ? "composer.effort" : undefined}
                  size={size}
                  className={cn(
                    isCodexStyle
                      ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap sm:max-w-48"
                      : "shrink-0 whitespace-nowrap",
                    triggerClassName,
                  )}
                />
              }
            />
          }
        >
          {isCodexStyle ? (
            <span
              className={cn(
                "flex min-w-0 w-full items-center",
                size === "xs" ? "gap-1" : "gap-1.5",
              )}
            >
              <ComposerControlIcon icon={BrainIcon} size={size} />
              <span data-composer-control-label className="min-w-0 truncate">
                {triggerLabel}
              </span>
              <ComposerControlChevron size={size} />
            </span>
          ) : (
            <>
              <ComposerControlIcon icon={BrainIcon} size={size} />
              <span data-composer-control-label>{triggerLabel}</span>
              <ComposerControlChevron size={size} />
            </>
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" {...(isComposerOwned ? composerFloatingLayerProps : {})}>
        <TraitsMenuContent
          provider={provider}
          {...(instanceId ? { instanceId } : {})}
          models={models}
          model={model}
          promptUltrathink={promptUltrathink}
          {...(onPromptEdit ? { onPromptEdit } : {})}
          modelOptions={modelOptions}
          reportedModelSelection={reportedModelSelection}
          allowPromptInjectedEffort={allowPromptInjectedEffort}
          planModeEnabled={planModeEnabled}
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
});

const EFFORT_THUMB_SIZE = "2rem";

/** The effort slider's dots sit under each thumb stop, so they share its edge-aligned math. */
function effortStopPosition(index: number, stepCount: number): string {
  const fraction = stepCount > 1 ? index / (stepCount - 1) : 0;
  return `calc(${EFFORT_THUMB_SIZE} / 2 + (100% - ${EFFORT_THUMB_SIZE}) * ${fraction})`;
}

/**
 * The composer's reasoning control: a bare label that opens the current step, the model it
 * applies to, and a slider over the model's reasoning steps. Remaining traits (speed, context,
 * agent) stay reachable below the slider.
 */
function ComposerTraitsPicker({
  traitsInput,
  triggerLabel,
  size,
  hidden,
  disabled,
  triggerClassName,
  onOpenModelPicker,
}: {
  traitsInput: Parameters<typeof useTraitsController>[0];
  triggerLabel: string;
  size: ComposerControlSize;
  hidden: boolean;
  disabled: boolean;
  triggerClassName?: string;
  onOpenModelPicker?: () => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(hidden || disabled);
  const sliderInputRef = useRef<HTMLInputElement>(null);
  const controller = useTraitsController(traitsInput);
  const reasoningDescriptor = controller.modelIsUnavailable
    ? null
    : findReasoningDescriptor(controller.selectDescriptors);
  const stepIndex = reasoningDescriptor
    ? resolveEffortStepIndex(
        reasoningDescriptor,
        controller.selectedSelectValue(reasoningDescriptor),
      )
    : 0;
  const steps = reasoningDescriptor?.options ?? [];
  const reasoningLocked = reasoningDescriptor
    ? controller.isSelectLocked(reasoningDescriptor)
    : false;
  const heading = steps[stepIndex]?.label ?? triggerLabel;
  const otherSelects = controller.modelIsUnavailable
    ? []
    : controller.selectDescriptors.filter((descriptor) => descriptor !== reasoningDescriptor);
  const booleans = controller.modelIsUnavailable ? [] : controller.booleanDescriptors;
  const normalizedModel = normalizeModelSlug(traitsInput.model, traitsInput.provider);
  const modelEntry = traitsInput.models.find((candidate) => candidate.slug === normalizedModel);
  const modelLabel = modelEntry
    ? getTriggerDisplayModelName(modelEntry)
    : (traitsInput.model ?? "");

  return (
    <Popover open={open} onOpenChange={(next) => setOpen(next && !disabled)}>
      <PopoverTrigger
        render={
          <ComposerControl
            disabled={disabled}
            aria-label={`Reasoning: ${triggerLabel}`}
            data-composer-shortcut="composer.effort"
            data-chat-composer-traits-trigger="true"
            size={size}
            className={cn(
              "min-w-0 max-w-40 shrink-0 font-normal text-muted-foreground sm:max-w-48",
              triggerClassName,
            )}
          />
        }
      >
        <span className="min-w-0 truncate">{triggerLabel}</span>
      </PopoverTrigger>
      <PopoverPopup
        {...composerFloatingLayerProps}
        side="top"
        align="end"
        padding="none"
        width="sm"
        initialFocus={reasoningDescriptor && !reasoningLocked ? sliderInputRef : true}
      >
        <div className="flex flex-col gap-3 p-3" data-chat-composer-traits-popover="true">
          <div className="flex min-w-0 flex-col items-center gap-0.5">
            <div className="font-semibold text-base text-primary leading-6" aria-live="polite">
              {heading}
            </div>
            {modelLabel ? (
              onOpenModelPicker ? (
                <button
                  type="button"
                  className="flex max-w-full cursor-pointer items-center gap-0.5 rounded-sm px-1 text-muted-foreground text-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  aria-label={`Change model, current ${modelLabel}`}
                  onClick={() => {
                    setOpen(false);
                    onOpenModelPicker();
                  }}
                >
                  <span className="min-w-0 truncate">{modelLabel}</span>
                  <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0" />
                </button>
              ) : (
                <div className="max-w-full truncate text-muted-foreground text-sm">
                  {modelLabel}
                </div>
              )
            ) : null}
          </div>
          {reasoningDescriptor ? (
            <SliderPrimitive.Root
              value={stepIndex}
              min={0}
              max={steps.length - 1}
              step={1}
              thumbAlignment="edge"
              disabled={reasoningLocked}
              onValueChange={(value) => {
                const option = steps[value];
                if (option && value !== stepIndex) {
                  controller.handleSelectChange(reasoningDescriptor, option.id);
                }
              }}
              className="w-full data-disabled:opacity-64"
            >
              <SliderPrimitive.Control className="relative flex h-8 w-full cursor-pointer touch-none select-none items-center data-disabled:cursor-not-allowed">
                <SliderPrimitive.Track className="relative h-8 w-full overflow-hidden rounded-full bg-foreground/8">
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 start-0 rounded-full bg-primary"
                    style={{
                      width: `calc(${EFFORT_THUMB_SIZE} + (100% - ${EFFORT_THUMB_SIZE}) * ${
                        steps.length > 1 ? stepIndex / (steps.length - 1) : 0
                      })`,
                    }}
                  />
                  {steps.map((option, index) => (
                    <span
                      key={option.id}
                      aria-hidden="true"
                      className={cn(
                        "absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full",
                        index < stepIndex ? "bg-primary-foreground/70" : "bg-muted-foreground/50",
                      )}
                      style={{ left: effortStopPosition(index, steps.length) }}
                    />
                  ))}
                  <SliderPrimitive.Thumb
                    inputRef={sliderInputRef}
                    getAriaLabel={() => reasoningDescriptor.label}
                    getAriaValueText={(_formatted, value) => steps[value]?.label ?? ""}
                    className="size-8 rounded-full bg-white shadow-md ring-1 ring-black/8 outline-none has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-ring"
                  />
                </SliderPrimitive.Track>
              </SliderPrimitive.Control>
            </SliderPrimitive.Root>
          ) : null}
          {reasoningLocked ? (
            <div className="text-pretty text-muted-foreground text-xs">
              Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change{" "}
              {reasoningDescriptor?.label.toLowerCase()}.
            </div>
          ) : null}
          {controller.modelIsUnavailable
            ? controller.descriptors.map((descriptor) => {
                const value = getProviderOptionCurrentLabel(
                  descriptor,
                  controller.modelSelection,
                  traitsInput.reportedModelSelection,
                );
                if (!value) return null;
                return (
                  <div
                    key={descriptor.id}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="text-muted-foreground">{descriptor.label}</span>
                    <span className="truncate text-foreground">{value}</span>
                  </div>
                );
              })
            : null}
          {otherSelects.map((descriptor) => {
            const selectedValue = controller.selectedSelectValue(descriptor) ?? "";
            return (
              <div key={descriptor.id} className="flex flex-col gap-1.5">
                <span className="font-medium text-muted-foreground text-xs">
                  {descriptor.label}
                </span>
                <ToggleGroup
                  aria-label={descriptor.label}
                  className="w-full flex-wrap"
                  value={[selectedValue]}
                  disabled={controller.isSelectLocked(descriptor)}
                  onValueChange={(values) => {
                    const value = values[0];
                    if (typeof value === "string") controller.handleSelectChange(descriptor, value);
                  }}
                >
                  {descriptor.options.map((option) => (
                    <ToggleGroupItem
                      key={option.id}
                      value={option.id}
                      className="flex-1"
                      {...(option.description ? { title: option.description } : {})}
                    >
                      {option.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            );
          })}
          {booleans.map((descriptor) => (
            <label
              key={descriptor.id}
              className="flex cursor-pointer items-center justify-between gap-3 text-xs"
            >
              <span className="font-medium text-muted-foreground">{descriptor.label}</span>
              <Switch
                size="sm"
                checked={descriptor.currentValue === true}
                onCheckedChange={(checked) =>
                  controller.handleBooleanChange(descriptor.id, checked)
                }
              />
            </label>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
