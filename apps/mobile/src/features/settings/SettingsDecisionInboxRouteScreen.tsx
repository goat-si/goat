import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { EnvironmentId } from "@goat/contracts";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function SettingsDecisionInboxRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const [includeClosed, setIncludeClosed] = useState(false);
  const insets = useSafeAreaInsets();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Decision inbox" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <Text className="text-sm text-foreground-muted">
            Review decisions here. Answer them from web or desktop.
          </Text>
          <Button
            label={includeClosed ? "Show open only" : "Show answered and expired"}
            onPress={() => setIncludeClosed(!includeClosed)}
          />
          {selectedTargets.length === 0 ? (
            <Text className="text-base text-foreground-muted">
              Connect or select an environment to view decisions.
            </Text>
          ) : (
            selectedTargets.map((environment) => (
              <EnvironmentDecisions
                key={environment.environmentId}
                environmentId={environment.environmentId}
                label={environment.label}
                includeClosed={includeClosed}
              />
            ))
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function EnvironmentDecisions({
  environmentId,
  label,
  includeClosed,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly includeClosed: boolean;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.decisionItems({
      environmentId,
      input: { limit: 100, ...(includeClosed ? {} : { status: "open" as const }) },
    }),
  );
  return (
    <SettingsSection title={label}>
      <View className="gap-3 p-4">
        <Button label="Refresh" disabled={query.isPending} onPress={query.refresh} />
        {query.error ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {query.error}
          </Text>
        ) : null}
        {query.data?.unavailableHosts.map((failure) => (
          <Text
            key={failure.host}
            accessibilityRole="alert"
            className="text-sm text-danger-foreground"
          >
            {failure.host}: {failure.message}
          </Text>
        ))}
        {!query.data ? (
          <Text className="text-base text-foreground-muted">
            {query.error ? "Could not load decisions. Try Refresh." : "Loading decisions…"}
          </Text>
        ) : query.data.items.length === 0 ? (
          <Text className="text-base text-foreground-muted">
            {includeClosed ? "No decisions yet." : "No open decisions."}
          </Text>
        ) : (
          query.data.items.map((item) => (
            <View
              key={JSON.stringify([
                item.from.environmentId ?? environmentId,
                item.from.host,
                item.id,
              ])}
              className="gap-1 border-t border-border-subtle pt-3"
            >
              <Text className="text-lg font-goat-medium text-foreground">{item.title}</Text>
              <Text className="text-sm text-foreground-muted">{item.context}</Text>
              <Text className="text-sm text-foreground-muted">
                {item.status} · {item.requiredProfile}
                {item.humanRequired ? " · Human response required" : ""}
                {item.from.host ? ` · ${item.from.host}` : ""}
              </Text>
              {item.pending?.questions.map((question) => (
                <View key={question.id} className="gap-1 pt-1">
                  <Text className="text-base text-foreground">{question.question}</Text>
                  {question.options.map((option) => (
                    <Text
                      key={option.value ?? option.label}
                      className="text-sm text-foreground-muted"
                    >
                      {option.label}: {option.description}
                    </Text>
                  ))}
                </View>
              ))}
              {item.pending?.questions.length
                ? null
                : item.options.map((option) => (
                    <Text key={option.id} className="text-sm text-foreground-muted">
                      {option.label}
                      {item.recommended === option.id ? " (recommended)" : ""}
                      {option.consequence ? `: ${option.consequence}` : ""}
                    </Text>
                  ))}
              {item.answer ? (
                <Text className="text-base text-foreground">
                  Answered:{" "}
                  {item.options.find((option) => option.id === item.answer)?.label ?? item.answer}
                  {(item.answeredByLabel ?? item.answeredBy)
                    ? ` · ${item.answeredByLabel ?? item.answeredBy}`
                    : ""}
                </Text>
              ) : null}
              {item.expiresAt ? (
                <Text className="text-sm text-foreground-muted">
                  Expires {new Date(item.expiresAt).toLocaleString()}
                </Text>
              ) : null}
            </View>
          ))
        )}
        {query.data?.truncated ? (
          <Text className="text-sm text-foreground-muted">Some decisions are not shown.</Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}
