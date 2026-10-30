import { buildModelQuickPicks } from "@goat/client-runtime/model-quick-picks";
import { getProviderOptionCurrentLabel } from "@goat/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { cn } from "../../lib/cn";
import type { ModelOption } from "../../lib/modelOptions";
import { environmentServerConfigsAtom } from "../../state/server";
import { ChatGptSharingStatus } from "./ChatGptSharingStatus";
import { ModelRow } from "./ThreadSettingsRows";
import { resolveReasoningSlider, ThreadSettingsReasoning } from "./ThreadSettingsReasoning";
import {
  useThreadSettingsSession,
  type ThreadSettingsSessionValue,
  type ThreadSettingsSubmenuPage,
} from "./thread-settings-session";

// The current model, reasoning and runtime must stay above the fold; the catalog is one tap away.
const QUICK_PICK_LIMIT = 4;

function DisclosureRow(props: {
  readonly label: string;
  readonly value: string | undefined;
  readonly onPress: () => void;
  readonly isLast?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className={cn(
        "min-h-11 flex-row items-center gap-2 bg-grouped-card px-4 py-2 active:bg-subtle android:min-h-14",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <Text className="text-sm font-goat-medium text-foreground">{props.label}</Text>
      <View className="flex-1" />
      {props.value ? (
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.value}
        </Text>
      ) : null}
      <SymbolView
        name="chevron.right"
        size={12}
        tintColorClassName="accent-icon-subtle"
        type="monochrome"
      />
    </Pressable>
  );
}

function SwitchRow(props: {
  readonly label: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly isLast?: boolean;
}) {
  return (
    <View
      className={cn(
        "min-h-11 flex-row items-center justify-between bg-grouped-card px-4 py-1",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <Text className="text-sm font-goat-medium text-foreground">{props.label}</Text>
      <ThemedSwitch
        accessibilityLabel={props.label}
        onValueChange={props.onValueChange}
        value={props.value}
      />
    </View>
  );
}

function SectionLabel(props: { readonly children: string }) {
  return (
    <Text
      accessibilityRole="header"
      className="px-5 pb-2 pt-5 text-sm font-goat-medium text-foreground-muted"
    >
      {props.children}
    </Text>
  );
}

function OverviewModelRow(props: {
  readonly session: ThreadSettingsSessionValue;
  readonly option: ModelOption;
  readonly selected: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}) {
  return (
    <ModelRow
      favoritesLoaded={props.session.favoritesLoaded}
      isFavorite={props.session.favoriteKeys.has(props.option.key)}
      isFirst={props.isFirst}
      isLast={props.isLast}
      onPress={() => props.session.pressModel(props.option)}
      onToggleFavorite={() => props.session.toggleFavorite(props.option)}
      option={props.option}
      selected={props.selected}
      showProviderIcon
    />
  );
}

function quickPickModels(session: ThreadSettingsSessionValue): ReadonlyArray<ModelOption> {
  const excludeKeys = new Set(
    [session.displayedModel?.key, session.appliedModel?.key].filter(
      (key): key is string => key !== undefined,
    ),
  );
  return buildModelQuickPicks({
    models: session.providerGroups.flatMap((group) => group.models),
    excludeKeys,
    favoriteKeys: session.favoriteKeys,
    recentKeys: session.recentModelKeys,
    limit: QUICK_PICK_LIMIT,
  }).map((pick) => pick.model);
}

export function ThreadSettingsOverview(props: {
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
  readonly onOpenCatalog: () => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const selectedProvider = session.environmentId
    ? (configs
        .get(session.environmentId)
        ?.providers.find((provider) => provider.instanceId === session.providerInstanceId) ?? null)
    : null;
  const slider = resolveReasoningSlider(session);
  const optionDescriptors = session.displayedDescriptors.filter(
    (descriptor) => descriptor.id !== slider?.descriptor.id,
  );
  const quickPicks = quickPickModels(session);
  const catalogCount = session.providerGroups.reduce(
    (count, group) => count + group.models.length,
    0,
  );
  const displayed = session.displayedModel;
  const fallbackModelName = session.displayedModelSelection?.model;

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      style={
        Platform.OS === "android"
          ? { width: "100%", maxWidth: 720, alignSelf: "center" }
          : undefined
      }
      contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      <ChatGptSharingStatus provider={selectedProvider} />
      <SectionLabel>Model</SectionLabel>
      {displayed ? (
        <OverviewModelRow isFirst isLast option={displayed} selected session={session} />
      ) : (
        <View className="mx-4 min-h-11 justify-center gap-0.5 rounded-2xl bg-grouped-card px-4 py-2">
          <Text className="text-base font-goat-medium text-foreground">
            {fallbackModelName ?? "No model selected"}
          </Text>
          {fallbackModelName ? (
            <Text className="text-xs text-foreground-muted">
              Not in this environment's available models right now.
            </Text>
          ) : null}
        </View>
      )}
      {session.pendingModel ? (
        <View className="flex-row items-center gap-2 px-5 pt-1">
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
            {`Save to switch from ${
              session.appliedModel?.label ??
              session.appliedModelSelection?.model ??
              "the current model"
            }.`}
          </Text>
          <Pressable
            accessibilityRole="button"
            className="min-h-11 justify-center active:opacity-60"
            hitSlop={8}
            onPress={session.keepAppliedModel}
          >
            <Text className="text-xs font-goat-medium text-primary">Keep current</Text>
          </Pressable>
        </View>
      ) : null}

      <ThreadSettingsReasoning session={session} slider={slider} />

      <SectionLabel>Options</SectionLabel>
      <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">
        {optionDescriptors.map((descriptor) =>
          descriptor.type === "select" ? (
            <DisclosureRow
              key={descriptor.id}
              label={descriptor.label}
              value={
                session.promptTraits.ultrathinkPromptControlled &&
                descriptor.id === session.promptTraits.primarySelectDescriptor?.id
                  ? "Ultrathink"
                  : getProviderOptionCurrentLabel(
                      descriptor,
                      session.displayedModelSelection,
                      session.reportedModelSelection,
                    )
              }
              onPress={() => props.onOpenSubmenu({ kind: "descriptor", id: descriptor.id })}
            />
          ) : (
            <SwitchRow
              key={descriptor.id}
              label={descriptor.label}
              value={descriptor.currentValue ?? false}
              onValueChange={(value) => session.applyOptionChange(descriptor.id, value)}
            />
          ),
        )}
        <DisclosureRow
          isLast
          label="Runtime"
          value={
            session.runtimeModeChoices.find((choice) => choice.mode === session.runtimeMode)?.label
          }
          onPress={() => props.onOpenSubmenu({ kind: "runtime" })}
        />
      </View>

      <SectionLabel>{quickPicks.length > 0 ? "Switch model" : "More models"}</SectionLabel>
      {quickPicks.map((option, index) => (
        <OverviewModelRow
          key={option.key}
          isFirst={index === 0}
          isLast={false}
          option={option}
          selected={false}
          session={session}
        />
      ))}
      <View
        className={cn(
          "mx-4 overflow-hidden bg-grouped-card",
          quickPicks.length > 0 ? "rounded-b-2xl" : "rounded-2xl",
        )}
      >
        <DisclosureRow
          isLast
          label="All models"
          value={catalogCount > 0 ? String(catalogCount) : undefined}
          onPress={props.onOpenCatalog}
        />
      </View>
    </ScrollView>
  );
}
