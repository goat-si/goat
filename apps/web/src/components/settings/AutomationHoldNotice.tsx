import type { EnvironmentId } from "@goat/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import { useState } from "react";

import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { WorkspacePageContainer } from "../WorkspacePageContainer";

const configsAtom = environmentAtomList(
  "web-automation-hold-configs",
  serverEnvironment.configValueAtom,
);

/**
 * One notice per environment whose server holds its automation: a nightly app's copy of stable's
 * data. Resuming is per environment on purpose, and the live config stream removes the notice, so
 * it shows until the hold is gone rather than until dismissed.
 */
export function AutomationHoldNotices() {
  const { environments } = useEnvironments();
  const configs = useAtomValue(
    configsAtom(environmentIdsKey(environments.map(({ environmentId }) => environmentId))),
  );
  const held = environments.filter((_, index) => configs[index]?.automationHold);
  if (held.length === 0) return null;
  return (
    <WorkspacePageContainer className="flex-none gap-2 pb-0">
      {held.map((environment) => (
        <AutomationHoldNotice
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
        />
      ))}
    </WorkspacePageContainer>
  );
}

function AutomationHoldNotice({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const allowed = useAtomValue(serverEnvironment.resumeAutomation.permissionAtom(environmentId));
  const resume = useAtomCommand(serverEnvironment.resumeAutomation);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!config?.automationHold) return null;

  const onResume = async () => {
    setPending(true);
    setError(null);
    const result = await resume({ environmentId, input: {} });
    setPending(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(String(squashAtomCommandFailure(result)));
    }
  };

  return (
    <Alert variant="warning">
      <AlertTitle>Automation is paused on {label}</AlertTitle>
      <AlertDescription>
        <p>
          This app started with a copy of GOAT's data, so scheduled tasks, channel bots, goals and
          Fleet work, and hub and remote links would also run here. They stay paused until you
          resume them, so nothing runs twice while GOAT keeps running them.
        </p>
        {allowed ? null : <p>Resuming needs permission to change this environment's settings.</p>}
        {error === null ? null : <p className="text-destructive-foreground">{error}</p>}
      </AlertDescription>
      <AlertAction>
        <Button
          size="xs"
          variant="outline"
          disabled={!allowed || pending}
          onClick={() => void onResume()}
        >
          Resume automation on this app
        </Button>
      </AlertAction>
    </Alert>
  );
}
