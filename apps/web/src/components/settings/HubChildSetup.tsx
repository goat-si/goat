import { msg, useGT, useLocale, useMessages } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import { type ChildSetup } from "@goat/client-runtime/hub-devices";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { EnvironmentId } from "@goat/contracts";
import { useRef, useState } from "react";

import { relativeTimeElapsedMs } from "~/timestampFormat";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import type { HubActions } from "./HubDeviceActions";

const TONE_TEXT: Record<ChildSetup["tone"], string> = {
  progress: "text-muted-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  destructive: "text-destructive-foreground",
};

const STEP_OUTCOME: Record<ChildSetup["steps"][number]["outcome"], string> = {
  pending: msg("Waiting"),
  running: msg("In progress"),
  succeeded: msg("Done"),
  failed: msg("Failed"),
};
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
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const relative = (at: number) => {
    const minutes = (relativeTimeElapsedMs(new Date(at).toISOString()) ?? 0) / 60_000;
    if (!minutes) return gt("just now");
    const format = new Intl.RelativeTimeFormat(locale, { style: "narrow" });
    return minutes < 60
      ? format.format(-minutes, "minute")
      : minutes < 1440
        ? format.format(-Math.floor(minutes / 60), "hour")
        : format.format(-Math.floor(minutes / 1440), "day");
  };
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
  const attempt = async (host: string): Promise<string | null> => {
    if (repairs) {
      await actions.run("repair", host);
      return null;
    }
    const result = await continueSetup({ environmentId, input: { deviceAlias: host } });
    onRefresh();
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      return failure instanceof Error ? failure.message : gt("Setup could not start. Try again.");
    }
    return result.value.kind === "error" ? result.value.failure.message : null;
  };
  const run = async () => {
    const host = setup.host;
    if (inFlight.current || host === null || !setup.actionable || !allowed || moving) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    // React Compiler cannot lower try/finally, so the promise carries the failure instead.
    const failure = await attempt(host).catch((cause: unknown) =>
      cause instanceof Error ? cause.message : gt("Setup could not start. Try again."),
    );
    inFlight.current = false;
    setPending(false);
    if (failure !== null) setError(failure);
  };
  return (
    <div className="space-y-1.5 text-xs">
      <p className={TONE_TEXT[setup.tone]}>
        <span role="status">{setup.label}</span> · {relative(setup.checkedAt)}
      </p>
      {setup.detail === null ? null : <p className="text-muted-foreground">{setup.detail}</p>}
      {setup.proof === null ? null : (
        <p className="text-muted-foreground">
          {gt("Verified with {model} {time}", {
            model: setup.proof.model,
            time: relative(setup.proof.completedAt),
          })}
        </p>
      )}
      {setup.steps.length === 0 ? null : (
        <details>
          <summary className="cursor-pointer text-muted-foreground">{gt("Setup steps")}</summary>
          <ol className="mt-1 space-y-0.5">
            {setup.steps.map((step) => (
              <li key={step.label}>
                {step.label}:{" "}
                <span className="text-muted-foreground">{m(STEP_OUTCOME[step.outcome])}</span>
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
            {pending ? gt("Working…") : setup.actionLabel}
          </Button>
          <span className="text-muted-foreground">
            {allowed
              ? repairs
                ? null
                : gt("Setup ends with one small request through Home, using its shared quota.")
              : gt("Managing this device needs permission on the selected Home.")}
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
