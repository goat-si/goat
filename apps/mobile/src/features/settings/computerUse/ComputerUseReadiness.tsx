import {
  computerUseReadinessSteps,
  type ReadinessStepState,
} from "@goat/client-runtime/computerUse/readinessSteps";
import type { EnvironmentId } from "@goat/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { SettingsActionRow } from "../components/SettingsActionRow";
import { SettingsSection } from "../components/SettingsSection";

const stateLabels = {
  ok: "Ready",
  pending: "Waiting",
  blocked: "Needs attention",
  unsupported: "Unsupported",
  unknown: "Not checked",
} as const satisfies Record<ReadinessStepState, string>;

export function ComputerUseReadiness(input: Parameters<typeof computerUseReadinessSteps>[0]) {
  const result = computerUseReadinessSteps(input);
  return (
    <View accessibilityLabel="Computer use readiness" className="gap-4 p-4">
      <Text textRole="body">
        {result.ready
          ? "Computer use is ready on this host."
          : "Computer use setup needs attention."}
      </Text>
      {result.steps.map((step, index) => (
        <View key={step.id} className="gap-1">
          <Text textRole="body">
            {index + 1}. {step.title} · {stateLabels[step.state]}
          </Text>
          {[...new Set(step.detail)].map((line) => (
            <Text key={line} textRole="footnote" selectable>
              {line}
            </Text>
          ))}
          {step.grants.map((row) => (
            <View key={row.grant} className="gap-1 pl-3">
              <Text textRole="body">
                {row.title} · {stateLabels[row.status]}
              </Text>
              {[...new Set(row.detail)].map((line) => (
                <Text key={line} textRole="footnote" selectable>
                  {line}
                </Text>
              ))}
            </View>
          ))}
        </View>
      ))}
      <Text textRole="footnote">Permissions must be granted on this host's desktop.</Text>
    </View>
  );
}

export function ComputerUseHostReadiness({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const query = useEnvironmentQuery(serverEnvironment.computerUse({ environmentId, input: {} }));
  return (
    <SettingsSection title="Computer use">
      {query.error ? (
        <Text textRole="footnote" accessibilityRole="alert">
          {query.error}
        </Text>
      ) : null}
      <ComputerUseReadiness
        platform={query.data?.platform}
        readiness={query.data?.readiness}
        tools={query.data?.tools}
        signals={query.data?.signals}
      />
      <SettingsActionRow
        icon="arrow.clockwise"
        label="Refresh computer use readiness"
        disabled={query.isPending}
        onPress={query.refresh}
      />
    </SettingsSection>
  );
}
