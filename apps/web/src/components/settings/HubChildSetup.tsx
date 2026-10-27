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

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button } from "../ui/button";
import type { HubActions } from "./HubDeviceActions";

const TONE_TEXT: Record<ChildSetup["tone"], string> = {
  progress: "text-muted-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  destructive: "text-destructive-foreground",
};

const relative = (at: number) => formatRelativeTimeLabel(new Date(at).toISOString());

/**
 * A hub device's Child setup: the step the Home reports, what failed, and one next action. Repair
 * goes through the device actions so an approval it needs can be continued there.
 */
export function HubChildSetup({
  environmentId,
  setup,
  actions,
  onRefresh,
}: {
  readonly environmentId: EnvironmentId;
  readonly setup: ChildSetup;
  readonly actions: HubActions;
  readonly onRefresh: () => void;
}) {
  const setupAllowed = useAtomValue(
    serverEnvironment.setupOpenCodexChild.permissionAtom(environmentId),
  );
  const continueSetup = useAtomCommand(serverEnvironment.setupOpenCodexChild, {
    reportFailure: false,
  });
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repairs = setup.nextAction === "reconnect_home";
  const allowed = repairs ? actions.allowed : setupAllowed;
  const moving = setup.tone === "progress";
  const run = async () => {
    const host = setup.host;
    if (inFlight.current || host === null || !setup.actionable || !allowed || moving) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      if (repairs) {
        await actions.run("repair", host);
        return;
      }
      const result = await continueSetup({ environmentId, input: { deviceAlias: host } });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Setup could not start. Try again.");
      } else if (result.value.kind === "error") setError(result.value.failure.message);
      onRefresh();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return (
    <div className="space-y-1.5 text-xs">
      <p role="status" className={TONE_TEXT[setup.tone]}>
        {setup.label} · {relative(setup.checkedAt)}
      </p>
      {setup.detail === null ? null : <p className="text-muted-foreground">{setup.detail}</p>}
      {setup.proof === null ? null : (
        <p className="text-muted-foreground">
          Verified with {setup.proof.model} {relative(setup.proof.completedAt)}
        </p>
      )}
      {setup.steps.length === 0 ? null : (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Setup steps</summary>
          <ol className="mt-1 space-y-0.5">
            {setup.steps.map((step) => (
              <li key={step.label}>
                {step.label}:{" "}
                <span className="text-muted-foreground">
                  {CHILD_STEP_OUTCOME_LABEL[step.outcome]}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
      {setup.actionLabel === null ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            disabled={!allowed || pending || moving || setup.host === null}
            onClick={() => void run()}
          >
            {pending ? "Working…" : setup.actionLabel}
          </Button>
          <span className="text-muted-foreground">
            {allowed ? (repairs ? null : CHILD_SETUP_QUOTA_NOTE) : CHILD_SETUP_PERMISSION_NOTE}
          </span>
        </div>
      )}
      {setup.guidance === null ? null : <p className="text-muted-foreground">{setup.guidance}</p>}
      {error === null ? null : (
        <p role="alert" className="text-destructive">
          {setup.host}: {error}
        </p>
      )}
    </div>
  );
}
