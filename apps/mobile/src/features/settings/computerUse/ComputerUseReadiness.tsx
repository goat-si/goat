import {
  computerUseReadinessSteps,
  type ReadinessStepState,
} from "@goat/client-runtime/computerUse/readinessSteps";
import type { ComputerUseSetupStatus } from "@goat/client-runtime/computer-use-linux-setup";
import type { EnvironmentId } from "@goat/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { SettingsActionRow } from "../components/SettingsActionRow";
import { SettingsSection } from "../components/SettingsSection";
import { ComputerUseAdvancedRow, useComputerUseAdvanced } from "./ComputerUseAdvancedRow";

const stateLabels = {
  ok: "Ready",
  pending: "Waiting",
  blocked: "Needs attention",
  unsupported: "Unsupported",
  unknown: "Not checked",
} as const satisfies Record<ReadinessStepState, string>;

const setupLabels = {
  done: "Done",
  action: "To do",
  waiting: "Waiting",
  limited: "Limited",
  unavailable: "Unavailable",
} as const satisfies Record<ComputerUseSetupStatus, string>;

export function ComputerUseReadiness({
  details = true,
  ...input
}: Parameters<typeof computerUseReadinessSteps>[0] & {
  /** False shows only the one-line summary; the steps live under Advanced. */
  readonly details?: boolean;
}) {
  const result = computerUseReadinessSteps(input);
  return (
    <View accessibilityLabel="Computer use readiness" className="gap-4 p-4">
      <Text textRole="body">
        {result.ready
          ? "Computer use is ready on this host."
          : result.startsWithNextTurn
            ? "Computer use is ready on this host. It starts with the next agent turn."
            : "Computer use setup needs attention."}
      </Text>
      {details ? <ComputerUseReadinessDetails result={result} /> : null}
    </View>
  );
}

function ComputerUseReadinessDetails({
  result,
}: {
  readonly result: ReturnType<typeof computerUseReadinessSteps>;
}) {
  return (
    <>
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
      {result.linuxSetup ? (
        <View accessibilityLabel="Set up computer use on Linux" className="gap-3">
          <Text textRole="body">Set up on Linux</Text>
          {result.linuxSetup.steps.map((step, index) => (
            <View key={`${step.id}:${index}`} className="gap-1">
              <Text textRole="body">
                {step.title} · {setupLabels[step.status]}
              </Text>
              <Text textRole="footnote" selectable>
                {step.detail}
              </Text>
              {step.guidance.map((line) => (
                <Text
                  key={line.text}
                  textRole="footnote"
                  selectable
                  className={line.kind === "command" ? "font-mono" : undefined}
                >
                  {line.text}
                </Text>
              ))}
            </View>
          ))}
        </View>
      ) : null}
      <Text textRole="footnote">Permissions must be granted on this host's desktop.</Text>
    </>
  );
}

export function ComputerUseHostReadiness({
  environmentId,
  machine,
}: {
  readonly environmentId: EnvironmentId;
  readonly machine?: string | undefined;
}) {
  const query = useEnvironmentQuery(serverEnvironment.computerUse({ environmentId, input: {} }));
  const advanced = useComputerUseAdvanced();
  return (
    <SettingsSection title="Computer use">
      {query.error ? (
        <Text textRole="footnote" accessibilityRole="alert">
          {query.error}
        </Text>
      ) : null}
      <ComputerUseReadiness
        platform={query.data?.platform}
        machine={machine}
        readiness={query.data?.readiness}
        tools={query.data?.tools}
        signals={query.data?.signals}
        failure={query.data?.failure}
        details={advanced.expanded}
      />
      <ComputerUseAdvancedRow advanced={advanced} />
      <SettingsActionRow
        icon="arrow.clockwise"
        label="Refresh computer use readiness"
        disabled={query.isPending}
        onPress={query.refresh}
      />
    </SettingsSection>
  );
}
