import { RegistryContext } from "@effect/atom-react";
import { useContext } from "react";

import { sshRuntime } from "~/state/sshRuntime";
import { Button } from "../ui/button";
import { EnvironmentRow } from "./EnvironmentRow";
import { type PendingSshAdd, dismissPendingSshAdd, retryPendingSshAdd } from "./pendingSshAdds";
import { SshRuntimeSettingsRow } from "./SshRuntimeSettingsRow";

/** An SSH add that left the Add device dialog: live preparation until it saves, or its failure. */
export function PendingSshAddRow({
  add,
  originLabel,
  onReviewTrust,
}: {
  readonly add: PendingSshAdd;
  readonly originLabel: string;
  readonly onReviewTrust: (() => void) | undefined;
}) {
  const registry = useContext(RegistryContext);
  const failed = add.error !== null;
  const route = add.routeEnvironmentId !== null;
  return (
    <EnvironmentRow
      kind="server"
      label={add.label}
      subtitle={
        failed ? (
          <span className="text-destructive">{route ? "Couldn't add route" : "Couldn't add"}</span>
        ) : route ? (
          `Adding SSH route ${add.target.alias}`
        ) : (
          "Adding over SSH"
        )
      }
      below={
        <>
          {failed ? (
            <p role="alert" className="mt-1 max-w-lg text-xs text-destructive">
              {add.error}
            </p>
          ) : null}
          <SshRuntimeSettingsRow
            environmentId={add.environmentId}
            target={add.target}
            enabled
            pendingAdd
            connecting={!failed}
            settled={failed}
            originLabel={originLabel}
            {...(add.progress === null ? {} : { preparationProgress: add.progress })}
            {...(failed && onReviewTrust ? { onReviewTrust } : {})}
          />
        </>
      }
    >
      {failed ? (
        <>
          <Button
            variant="outline"
            size="xs"
            onClick={() => void retryPendingSshAdd(registry, add.key)}
          >
            Retry
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              dismissPendingSshAdd(registry, add.key);
              sshRuntime.forget(registry, { environmentId: add.environmentId, target: add.target });
            }}
          >
            Dismiss
          </Button>
        </>
      ) : null}
    </EnvironmentRow>
  );
}
