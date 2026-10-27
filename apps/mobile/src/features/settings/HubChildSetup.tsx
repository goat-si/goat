import { useAtomValue } from "@effect/atom-react";
import {
  CHILD_SETUP_PERMISSION_NOTE,
  CHILD_SETUP_QUOTA_NOTE,
  CHILD_STEP_OUTCOME_LABEL,
  type ChildSetup,
} from "@goat/client-runtime/hub-devices";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { EnvironmentId } from "@goat/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const TONE_TEXT: Record<ChildSetup["tone"], string> = {
  progress: "text-sm text-foreground-muted",
  success: "text-sm text-primary-text",
  warning: "text-sm text-warning-foreground",
  destructive: "text-sm text-danger-foreground",
};

/** Repair can need an approval that only the desktop and web device actions continue. */
const REPAIR_ELSEWHERE = "Repair this device's link from the hub's Settings on desktop or web.";

/** A hub device's Child setup: the step the Home reports, what failed, and one next action. */
export function HubChildSetup({
  environmentId,
  setup,
  onRefresh,
}: {
  readonly environmentId: EnvironmentId;
  readonly setup: ChildSetup;
  readonly onRefresh: () => void;
}) {
  const allowed = useAtomValue(serverEnvironment.setupOpenCodexChild.permissionAtom(environmentId));
  const continueSetup = useAtomCommand(serverEnvironment.setupOpenCodexChild, {
    reportFailure: false,
  });
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repairs = setup.nextAction === "reconnect_home";
  const moving = setup.tone === "progress";
  const run = async () => {
    const host = setup.host;
    if (inFlight.current || host === null || !setup.actionable || !allowed || moving) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    // A command reports failure in its result instead of throwing.
    const result = await continueSetup({ environmentId, input: { deviceAlias: host } });
    inFlight.current = false;
    setPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Setup could not start. Try again.");
    } else if (result.value.kind === "error") setError(result.value.failure.message);
    onRefresh();
  };
  return (
    <View className="gap-2">
      <Text accessibilityLiveRegion="polite" className={TONE_TEXT[setup.tone]}>
        {setup.label}
      </Text>
      {setup.detail === null ? null : (
        <Text className="text-sm text-foreground-muted">{setup.detail}</Text>
      )}
      {setup.proof === null ? null : (
        <Text className="text-sm text-foreground-muted">
          Verified with {setup.proof.model} · {new Date(setup.proof.completedAt).toLocaleString()}
        </Text>
      )}
      {setup.steps.length === 0 ? null : (
        <>
          <Button
            tone="text"
            label={details ? "Hide setup steps" : "Show setup steps"}
            onPress={() => setDetails(!details)}
          />
          {details
            ? setup.steps.map((step) => (
                <Text key={step.label} className="text-sm text-foreground">
                  {step.label}: {CHILD_STEP_OUTCOME_LABEL[step.outcome]}
                </Text>
              ))
            : null}
        </>
      )}
      {setup.actionLabel === null ? null : repairs ? (
        <Text className="text-sm text-foreground-muted">{REPAIR_ELSEWHERE}</Text>
      ) : (
        <>
          <Button
            tone="primary"
            label={pending ? "Working…" : setup.actionLabel}
            accessibilityLabel={setup.actionLabel}
            disabled={!allowed || pending || moving || setup.host === null}
            onPress={() => void run()}
          />
          <Text className="text-sm text-foreground-muted">
            {allowed ? CHILD_SETUP_QUOTA_NOTE : CHILD_SETUP_PERMISSION_NOTE}
          </Text>
        </>
      )}
      {setup.guidance === null ? null : (
        <Text className="text-sm text-foreground-muted">{setup.guidance}</Text>
      )}
      {error === null ? null : (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {setup.host}: {error}
        </Text>
      )}
    </View>
  );
}
