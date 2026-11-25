import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@goat/contracts";
import { useLocation } from "@tanstack/react-router";
import { useState } from "react";

import { primaryServerConfigAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { USAGE_DATA_DESCRIPTION } from "../settings/TelemetryConsentSetting";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { OnboardingFooter, OnboardingHeader, OnboardingPopup } from "./OnboardingDialog";

/**
 * The primary environment while its server still waits for an answer and this client may give
 * one. Older servers, an environment override, and the welcome wizard are not asked.
 */
export function useTelemetryConsentAsk(): EnvironmentId | null {
  const config = useAtomValue(primaryServerConfigAtom);
  const environmentId = config?.environment.environmentId ?? null;
  const canConfigure = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const onWelcome = useLocation({ select: (location) => location.pathname === "/welcome" });
  if (
    config === null ||
    environmentId === null ||
    onWelcome ||
    !canConfigure ||
    config.environment.capabilities.telemetryConsent !== true ||
    config.observability.telemetryOverride !== undefined ||
    config.settings.telemetryConsent !== "undecided"
  )
    return null;
  return environmentId;
}

/** Asks once whether this server may share usage data. Closing it asks again next launch. */
export function TelemetryConsentPrompt({
  environmentId,
  onClosed,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClosed: () => void;
}) {
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (telemetryConsent: "granted" | "declined") => {
    setSaving(true);
    setError(null);
    const result = await update({ environmentId, input: { patch: { telemetryConsent } } });
    setSaving(false);
    if (result._tag === "Failure") setError("Could not save. Try again.");
    else onClosed();
  };
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !saving) onClosed();
      }}
    >
      <OnboardingPopup>
        <OnboardingHeader
          title="Share usage data with GOAT?"
          description={`Nothing is sent unless you turn this on. ${USAGE_DATA_DESCRIPTION}`}
        />
        <OnboardingFooter
          hint={
            error ? (
              <span role="alert" className="text-destructive">
                {error}
              </span>
            ) : (
              "Change it anytime in Settings → General."
            )
          }
        >
          <Button variant="outline" disabled={saving} onClick={() => void answer("declined")}>
            Don't share
          </Button>
          <Button variant="outline" disabled={saving} onClick={() => void answer("granted")}>
            Share usage data
          </Button>
        </OnboardingFooter>
      </OnboardingPopup>
    </Dialog>
  );
}

/** For clients without the desktop's first-run sequence. */
export function TelemetryConsentCoordinator() {
  const environmentId = useTelemetryConsentAsk();
  const [closed, setClosed] = useState(false);
  if (environmentId === null || closed) return null;
  return <TelemetryConsentPrompt environmentId={environmentId} onClosed={() => setClosed(true)} />;
}
