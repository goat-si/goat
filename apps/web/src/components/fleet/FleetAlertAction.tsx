import { useAtomValue } from "@effect/atom-react";
import {
  formatHealthDuration,
  presentHostStorage,
} from "@goat/client-runtime/state/fleet-host-health";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { EnvironmentId } from "@goat/contracts";
import { RegistryContext } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { useContext, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { useNowWhile } from "~/hooks/useNowWhile";
import { hostStatusAtom } from "~/state/hostStatus";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { validateMemorySettingsSearch } from "../settings/MemorySettings.logic";
import type { FleetAlertActionKind } from "./fleetTelemetry";

const LABEL: Record<FleetAlertActionKind, string> = {
  retry: "Retry",
  compact: "Compact",
  clean_up: "Clean up",
  memory_settings: "Memory settings",
  storage: "Free up space",
};

const failureText = (failure: unknown) =>
  failure instanceof Error && failure.message.length > 0 ? failure.message : String(failure);

/** Reads the machine again now, so the alert reflects what the action changed. */
function useRefreshHostStatus() {
  const registry = useContext(RegistryContext);
  return (environmentId: EnvironmentId) => {
    registry.refresh(hostStatusAtom(environmentId, { local: true }));
    registry.refresh(hostStatusAtom(environmentId));
  };
}

/**
 * The one action an alert offers. While it runs it shows elapsed time; its result or failure
 * stays next to the alert, and the next host reading replaces both.
 */
export function FleetAlertAction(props: {
  readonly kind: FleetAlertActionKind;
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  if (props.kind === "memory_settings") {
    return (
      <Button
        size="micro"
        variant="ghost-muted"
        render={<Link to="/settings/memory" search={validateMemorySettingsSearch({})} />}
      >
        {LABEL.memory_settings}
      </Button>
    );
  }
  if (props.kind === "retry") return <RetryAction {...props} />;
  if (props.kind === "storage") {
    return (
      <Button
        size="micro"
        variant="ghost-muted"
        aria-label={"Free up space on " + props.label}
        render={<Link to="/settings/storage" search={{ machine: props.environmentId }} />}
      >
        {LABEL.storage}
      </Button>
    );
  }
  return <MaintenanceAction {...props} kind={props.kind} />;
}

function RetryAction(props: { readonly environmentId: EnvironmentId; readonly label: string }) {
  const retry = useAtomCommand(environmentCatalog.retryNow);
  return (
    <Button
      size="micro"
      variant="ghost-muted"
      aria-label={"Retry connecting to " + props.label}
      onClick={() => void retry(props.environmentId)}
    >
      {LABEL.retry}
    </Button>
  );
}

function MaintenanceAction(props: {
  readonly kind: "compact" | "clean_up";
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const command =
    props.kind === "compact"
      ? serverEnvironment.compactStorage
      : serverEnvironment.cleanUpStrayProcesses;
  const allowed = useAtomValue(command.permissionAtom(props.environmentId));
  const compact = useAtomCommand(serverEnvironment.compactStorage, { reportFailure: false });
  const cleanUp = useAtomCommand(serverEnvironment.cleanUpStrayProcesses, { reportFailure: false });
  const refresh = useRefreshHostStatus();
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<{
    readonly text: string;
    readonly failed: boolean;
  } | null>(null);
  const now = useNowWhile(startedAt !== null);
  if (!allowed) return null;

  const run = async () => {
    setOutcome(null);
    setStartedAt(Date.now());
    const target = { environmentId: props.environmentId, input: {} };
    if (props.kind === "compact") {
      const result = await compact(target);
      if (result._tag === "Success") {
        setOutcome({
          text: presentHostStorage(result.value, Date.now()).lastResult ?? "Compacted",
          failed: false,
        });
      } else if (!isAtomCommandInterrupted(result)) {
        setOutcome({ text: failureText(squashAtomCommandFailure(result)), failed: true });
      }
    } else {
      const result = await cleanUp(target);
      if (result._tag === "Success") {
        const { stopped, forced, failed } = result.value;
        setOutcome({
          text:
            "Stopped " +
            stopped +
            (forced > 0 ? " (" + forced + " forced)" : "") +
            (failed.length > 0 ? "; " + failed.length + " could not be stopped" : ""),
          failed: failed.length > 0,
        });
      } else if (!isAtomCommandInterrupted(result)) {
        setOutcome({ text: failureText(squashAtomCommandFailure(result)), failed: true });
      }
    }
    setStartedAt(null);
    refresh(props.environmentId);
  };

  if (startedAt !== null) {
    return (
      <span
        role="status"
        className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums"
      >
        {(props.kind === "compact" ? "Compacting · " : "Stopping · ") +
          formatHealthDuration(now - startedAt)}
      </span>
    );
  }
  return (
    <>
      {outcome === null ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="status"
                tabIndex={0}
                className={
                  outcome.failed
                    ? "min-w-0 max-w-40 truncate text-2xs text-destructive-foreground outline-hidden"
                    : "min-w-0 max-w-40 truncate text-2xs text-muted-foreground outline-hidden"
                }
              />
            }
          >
            {outcome.text}
          </TooltipTrigger>
          <TooltipPopup side="top">{outcome.text}</TooltipPopup>
        </Tooltip>
      )}
      <Button
        size="micro"
        variant="ghost-muted"
        aria-label={LABEL[props.kind] + " on " + props.label}
        onClick={() => void run()}
      >
        {outcome?.failed ? "Retry" : LABEL[props.kind]}
      </Button>
    </>
  );
}
