import type { PairingDiagnosis } from "@goat/client-runtime/connection";
import { View } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { pairingDiagnosticsCopy, pairingDiagnosticStepTitle } from "./pairingDiagnosticsCopy";

export function PairingDiagnostics(props: {
  readonly diagnosis: PairingDiagnosis;
  readonly errorMessage: string;
}) {
  return (
    <View
      collapsable={false}
      accessibilityLiveRegion="polite"
      className="overflow-hidden rounded-[26px] border-continuous bg-grouped-card"
    >
      {props.diagnosis.steps.map((step, index) => (
        <View key={step.id} collapsable={false}>
          {index > 0 ? <View className="ml-4 border-t border-border-subtle" /> : null}
          <View className="min-h-13 flex-row items-start gap-3 px-4 py-3">
            <SymbolView
              name={
                step.state === "passed"
                  ? "checkmark.circle.fill"
                  : step.state === "failed"
                    ? "xmark.circle.fill"
                    : "circle"
              }
              accessibilityLabel={step.state}
              size={22}
              tintColorClassName={
                step.state === "failed" ? "accent-danger-foreground" : "accent-icon-muted"
              }
              type="monochrome"
            />
            <View className="min-w-0 flex-1 gap-1">
              <Text className="text-base text-foreground">
                {pairingDiagnosticStepTitle(step.id, props.diagnosis.tailnet)}
              </Text>
              {step.state === "failed" ? (
                <Text className="text-sm leading-normal text-foreground-muted">
                  {pairingDiagnosticsCopy(props.diagnosis, props.errorMessage)}
                </Text>
              ) : null}
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}
