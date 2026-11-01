import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@goat/contracts";
import {
  collectExternalUsageLinks,
  cursorUsageWindowDetails,
  formatDuration,
  formatResetsIn,
  paceRemainingPercent,
  remainingPercent,
  type LimitPoolWindow,
} from "@goat/shared/usageLimits";
import {
  limitBoard,
  type LimitBoardGroup,
  type LimitBoardRow,
  type LimitBoardSection,
} from "@goat/shared/usageLimitsBoard";
import { Fragment, type ReactNode, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { environmentPresentations } from "../../state/presentation";
import { ResetCredits } from "./UsageLimitsSection";
import { usageProviderKind, useProviderColors } from "./usageProviders";

const DRIVER_LABEL: Partial<Record<string, string>> = {
  codex: "Codex",
  claudeAgent: "Claude",
  antigravity: "Antigravity",
};

const ORIGIN_LABEL = { pool: "Shared pool", login: "Direct login", proxy: "Proxy" } as const;

const STATUS = {
  ready: { label: "Ready", className: "text-foreground" },
  blocked: { label: "Blocked", className: "text-danger-foreground" },
  unknown: { label: "No reading", className: "text-foreground-muted" },
  paused: { label: "Paused", className: "text-foreground-muted" },
  reauth: { label: "Sign in again", className: "text-warning-foreground" },
} as const;

const VERDICT_CLASS = {
  ready: "text-foreground-muted",
  blocked: "text-danger-foreground",
  unknown: "text-foreground-muted",
} as const;

function rowName(row: LimitBoardRow) {
  if (row.name) return row.name;
  if (row.email) return "••••••@••••••";
  return DRIVER_LABEL[row.driver] ?? String(row.driver);
}

function LimitRow({
  row,
  group,
  color,
  now,
  environmentIds,
}: {
  readonly row: LimitBoardRow;
  readonly group: LimitBoardGroup;
  readonly color: string;
  readonly now: number;
  readonly environmentIds: readonly string[] | null;
}) {
  const navigation = useNavigation();
  const cells = group.windows.flatMap((window) => {
    const member = window.columns.find((column) => column.account.key === row.account?.key);
    return member?.window ? [{ pool: window, window: member.window }] : [];
  });
  const status = STATUS[row.status];
  const details = [
    row.plan && !row.name?.toLowerCase().includes(row.plan.toLowerCase()) ? row.plan : null,
    row.status === "blocked"
      ? row.releaseAt === null
        ? "Release time unknown"
        : `Frees in ${formatDuration(row.releaseAt - now)}`
      : null,
    row.note ?? null,
    row.alsoVia.length > 0 ? `Also via ${row.alsoVia.join(", ")}` : null,
  ].filter((detail) => detail !== null);
  const body = (
    <View className="gap-1.5 py-3">
      <View className="flex-row items-center gap-2">
        <Text numberOfLines={1} className="min-w-0 flex-1 text-sm font-goat-medium text-foreground">
          {rowName(row)}
        </Text>
        <View className="rounded-md bg-subtle px-1.5 py-0.5">
          <Text className={`text-xs font-goat-medium ${status.className}`}>{status.label}</Text>
        </View>
      </View>
      {details.length > 0 ? (
        <Text numberOfLines={2} className="text-xs text-foreground-muted">
          {details.join(" · ")}
        </Text>
      ) : null}
      {cells.map(({ pool, window }) => {
        const remaining = remainingPercent(window);
        return (
          <View key={`${pool.kind}:${pool.id}`} className="flex-row items-center gap-2">
            <Text numberOfLines={1} className="w-20 text-xs text-foreground-muted">
              {cursorUsageWindowDetails(pool.id)?.label ?? pool.label}
            </Text>
            <View className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-subtle">
              <View
                className="h-full rounded-full"
                style={{ width: `${remaining}%`, backgroundColor: color }}
              />
            </View>
            <Text className="w-16 text-right text-xs font-goat-medium tabular-nums text-foreground">
              {remaining}% left
            </Text>
            <Text className="w-14 text-right text-xs tabular-nums text-foreground-muted">
              {formatResetsIn(window, now)?.replace("resets in ", "↻ ") ?? ""}
            </Text>
          </View>
        );
      })}
    </View>
  );
  const first = cells[0];
  const account = row.account;
  if (!account) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${rowName(row)}, ${status.label}${cells.map(({ pool, window }) => `, ${pool.label} ${remainingPercent(window)}% left`).join("")}`}
      accessibilityHint="Show account details"
      onPress={() =>
        navigation.navigate("SettingsUsageAccount", {
          accountKey: account.key,
          ...(first ? { windowId: first.pool.id, windowKind: first.pool.kind } : {}),
          environmentIds,
          now,
        })
      }
      className="active:opacity-60"
    >
      {body}
    </Pressable>
  );
}

function LimitGroupCard({
  group,
  color,
  now,
  environmentIds,
}: {
  readonly group: LimitBoardGroup;
  readonly color: string;
  readonly now: number;
  readonly environmentIds: readonly string[] | null;
}) {
  return (
    <View className="gap-1 rounded-[24px] border-continuous bg-grouped-card px-4 pt-3 pb-1">
      <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
        <View className="rounded-md bg-subtle-strong px-1.5 py-0.5">
          <Text className="text-xs font-goat-medium text-foreground">
            {ORIGIN_LABEL[group.kind]}
          </Text>
        </View>
        <Text className="text-sm font-goat-medium text-foreground">{group.title}</Text>
      </View>
      {group.detail ? <Text className="text-xs text-foreground-muted">{group.detail}</Text> : null}
      {group.poolReadings ? (
        <Text className="text-xs tabular-nums text-foreground-muted">
          OpenCodex reports {group.poolReadings}
        </Text>
      ) : null}
      {group.windows.length > 0 ? (
        <Text className="text-xs tabular-nums text-foreground-muted">
          {group.windows
            .map((window) => `${window.label} ${window.remainingPercent}% left`)
            .join(" · ")}
        </Text>
      ) : null}
      {group.unreadable ? (
        <Text className="py-2 text-xs text-warning-foreground">
          GOAT can't read this pool, so its accounts and limits are hidden. {group.unreadable}
        </Text>
      ) : null}
      {group.blocks.map((block) => (
        <Text key={block} className="text-xs font-goat-medium text-danger-foreground">
          {block}
        </Text>
      ))}
      {group.rows.map((row, index) => (
        <View key={row.key} className={index === 0 ? undefined : "border-t border-border-subtle"}>
          <LimitRow
            row={row}
            group={group}
            color={color}
            now={now}
            environmentIds={environmentIds}
          />
        </View>
      ))}
      {group.rows.length === 0 && !group.unreadable ? (
        <Text className="pb-3 text-xs text-foreground-muted">No accounts reported.</Text>
      ) : null}
    </View>
  );
}

function LimitSectionView({
  section,
  color,
  now,
  environmentIds,
}: {
  readonly section: LimitBoardSection;
  readonly color: string;
  readonly now: number;
  readonly environmentIds: readonly string[] | null;
}) {
  return (
    <View className="gap-3">
      <View className="gap-0.5 px-1">
        <View className="flex-row items-center gap-2">
          <ProviderIcon provider={section.driver} size={18} />
          <Text className="text-base font-goat-medium text-foreground">
            {DRIVER_LABEL[section.driver] ?? section.driver}
          </Text>
        </View>
        <Text className={`text-sm ${VERDICT_CLASS[section.verdict.tone]}`}>
          {section.verdict.text}
        </Text>
      </View>
      {section.groups.map((group) => (
        <LimitGroupCard
          key={group.key}
          group={group}
          color={color}
          now={now}
          environmentIds={environmentIds}
        />
      ))}
    </View>
  );
}

export function UsageLimitsSection({
  now,
  failedLabels,
  selectedEnvironmentIds,
  cursorPrompt,
}: {
  readonly now: number;
  readonly failedLabels: readonly string[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly cursorPrompt?: ReactNode;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const selected =
    selectedEnvironmentIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedEnvironmentIds.has(id)));
  const { sections, notices } = limitBoard(selected, now);
  const externalLinks = collectExternalUsageLinks(selected);
  const colors = useProviderColors();
  const environmentIds = selectedEnvironmentIds === null ? null : [...selectedEnvironmentIds];
  const cursorPromptAt =
    Math.max(
      sections.findIndex((section) => section.driver === "codex"),
      sections.findIndex((section) => section.driver === "claudeAgent"),
    ) + 1;
  return (
    <View className="gap-6">
      {sections.length === 0 &&
      notices.length === 0 &&
      failedLabels.length === 0 &&
      !cursorPrompt &&
      externalLinks.length === 0 ? (
        <Text className="py-12 text-center text-base text-foreground-muted">
          {selected.size === 0
            ? "Select an environment to see limits."
            : "No provider on the selected environments reports subscription limits."}
        </Text>
      ) : null}
      {sections.map((section, index) => (
        <Fragment key={section.driver}>
          {index === cursorPromptAt ? cursorPrompt : null}
          <LimitSectionView
            section={section}
            color={colors[usageProviderKind(section.driver) ?? "codex"]}
            now={now}
            environmentIds={environmentIds}
          />
        </Fragment>
      ))}
      {cursorPromptAt === sections.length ? cursorPrompt : null}
      {externalLinks.map((link) => (
        <View key={link.url} className="gap-3 rounded-xl border border-border-subtle p-4">
          <Text className="text-base font-goat-medium text-foreground">{link.label}</Text>
          <Text className="text-xs text-foreground-muted">{link.accounts.join(", ")}</Text>
          {link.message ? (
            <Text className="text-sm text-foreground-muted">{link.message}</Text>
          ) : null}
          <Pressable
            accessibilityRole="link"
            className="min-h-11 justify-center"
            onPress={() => void Linking.openURL(link.url).catch(() => undefined)}
          >
            <Text className="text-sm font-goat-medium text-primary">Manage usage</Text>
          </Pressable>
        </View>
      ))}
      {notices.length > 0 || failedLabels.length > 0 ? (
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="flex-row items-start gap-2 rounded-xl border border-warning-border bg-warning px-3.5 py-3"
        >
          <SymbolView
            name="exclamationmark.triangle"
            size={16}
            tintColorClassName="accent-warning-foreground"
          />
          <View className="min-w-0 flex-1 gap-0.5">
            {notices.map((notice) => (
              <Text key={notice} className="text-sm font-goat-medium text-warning-foreground">
                {notice}
              </Text>
            ))}
            {failedLabels.length > 0 ? (
              <Text className="text-sm font-goat-medium text-warning-foreground">
                {failedLabels.join(", ")} could not refresh limits. Showing the last known values.
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

type AccountScreenProps = StaticScreenProps<{
  accountKey: string;
  windowId?: string;
  windowKind?: LimitPoolWindow["kind"];
  environmentIds: readonly string[] | null;
  now: number;
}>;

export function UsageLimitAccountScreen({ route }: AccountScreenProps) {
  const insets = useSafeAreaInsets();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const { accountKey, windowId, windowKind, environmentIds, now } = route.params;
  const selectedIds =
    environmentIds === null ? null : new Set(environmentIds.map((id) => EnvironmentId.make(id)));
  const selected =
    selectedIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedIds.has(id)));
  // The same group the Limits row came from, so its columns match what the row showed.
  const group = limitBoard(selected, now)
    .sections.flatMap((section) => section.groups)
    .find((candidate) => candidate.rows.some((row) => row.account?.key === accountKey));
  const account = group?.rows.find((row) => row.account?.key === accountKey)?.account ?? undefined;
  const pool = group?.windows.find(
    (candidate) => candidate.id === windowId && candidate.kind === windowKind,
  );
  const window =
    pool?.columns.find((member) => member.account.key === accountKey)?.window ?? undefined;
  const evenPace = window ? paceRemainingPercent(window, now) : null;
  const reset = pool?.resets.find((candidate) => candidate.member.account.key === accountKey);
  const [revealed, setRevealed] = useState(false);
  return (
    <SettingsScreen title="Account">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        {!account ? (
          <Text className="text-base text-foreground-muted">
            This account is no longer reporting limits on the selected environments.
          </Text>
        ) : (
          <>
            <View className="gap-2">
              <View className="flex-row items-center gap-2">
                <ProviderIcon provider={account.driver} size={24} />
                <Text className="flex-1 text-xl font-goat-bold text-foreground">
                  {account.poolName ??
                    account.displayName ??
                    DRIVER_LABEL[account.driver] ??
                    account.driver}
                </Text>
              </View>
              {account.email ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={revealed ? "Hide account email" : "Reveal account email"}
                  onPress={() => setRevealed((value) => !value)}
                  className="min-h-[44px] justify-center"
                >
                  <Text className="text-sm text-foreground-muted">
                    {revealed ? account.email : "••••••@••••••"}
                  </Text>
                </Pressable>
              ) : null}
              {account.plan ? (
                <Text selectable className="text-sm text-foreground-muted">
                  {account.plan}
                </Text>
              ) : null}
            </View>
            {window ? (
              <View className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
                <Text className="text-sm font-goat-medium text-foreground">{window.label}</Text>
                <Text className="text-3xl font-goat-bold tabular-nums text-foreground">
                  {remainingPercent(window)}% left
                </Text>
                {window.resetsAt ? (
                  <Text selectable className="text-sm text-foreground-muted">
                    Resets{" "}
                    {new Date(window.resetsAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </Text>
                ) : null}
                {evenPace !== null ? (
                  <Text className="text-sm text-foreground-muted">
                    Even pace: {evenPace}% left by now
                  </Text>
                ) : null}
                {reset && reset.restoresPercent > 0 ? (
                  <Text className="text-sm text-foreground-muted">
                    Restores {reset.restoresPercent}% of the pool
                  </Text>
                ) : null}
              </View>
            ) : null}
            <View className="gap-2 rounded-[24px] border-continuous bg-grouped-card p-4">
              <Text className="text-sm font-goat-medium text-foreground">
                {account.environments.length ? "Signed in" : "Source"}
              </Text>
              {account.environments.length ? (
                account.environments.map((environment) => (
                  <Text key={environment.environmentId} className="text-sm text-foreground-muted">
                    {environment.label}
                  </Text>
                ))
              ) : (
                <Text className="text-sm text-foreground-muted">{account.sourceLabel}</Text>
              )}
            </View>
            {account.redeem && account.limits.resetCredits ? (
              <View className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
                <Text className="text-sm font-goat-medium text-foreground">Reset credits</Text>
                <ResetCredits
                  key={account.key}
                  environmentId={account.redeem.environmentId}
                  input={account.redeem.input}
                  credits={account.limits.resetCredits}
                  now={now}
                />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
