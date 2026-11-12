import type { DesktopCuaGrants } from "@goat/contracts";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { ChevronRightIcon, CircleCheckIcon } from "~/components/solar";
import { MacAccessibilityIcon, MacScreenRecordingIcon } from "../Icons";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  CUA_GRANT_READS_INITIAL,
  cuaGrantReadsAfter,
  cuaGrantSteps,
  cuaGrantTroubleshooting,
  cuaReadAnswered,
  cuaReadIsFinal,
  type CuaGrantHolder,
  type CuaGrantStep,
  type CuaPermission,
  type CuaUnanswered,
} from "./CuaSetupDialog.logic";

/**
 * The grants of the app computer use runs as, read by a fresh helper process on each check while
 * setup is open. record and invalidate start a new epoch, so a read that began before them is
 * dropped; reads counts the answered reads, so a caller can wait for one newer than its own.
 * unanswered is set once reads stopped being answered; retry asks again now.
 */
export function useCuaGrants(
  check: () => Promise<DesktopCuaGrants>,
  enabled: boolean,
  intervalMs = 1500,
) {
  const [state, setState] = useState(CUA_GRANT_READS_INITIAL);
  const [reads, setReads] = useState(0);
  // Each Try again is one attempt: it restarts the polling below with a read the person asked for.
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const askedAttempt = useRef(0);
  const epoch = useRef(0);
  const readCount = useRef(0);
  const checkLatest = useEffectEvent(check);
  const settle = (next: DesktopCuaGrants | null, asked: boolean) => {
    setState((current) => cuaGrantReadsAfter(current, next, asked));
    if (!cuaReadAnswered(next)) return;
    readCount.current += 1;
    setReads(readCount.current);
  };
  const settleLatest = useEffectEvent(settle);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let checking = false;
    // A helper that cannot be used or refused GOAT stays that way, so only the person asks again.
    let final = false;
    const refresh = async (asked: boolean) => {
      if (disposed || checking || document.visibilityState === "hidden") return;
      checking = true;
      const started = epoch.current;
      // A read the desktop could not make at all counts like one the helper did not answer.
      const next = await checkLatest().catch(() => null);
      checking = false;
      if (asked) setRetrying(false);
      if (next !== null) final = cuaReadIsFinal(next);
      if (!disposed && started === epoch.current) settleLatest(next, asked);
    };
    const asked = attempt !== askedAttempt.current;
    askedAttempt.current = attempt;
    void refresh(asked);
    const comeBack = () => void refresh(false);
    const timer = window.setInterval(() => {
      if (!final) void refresh(false);
    }, intervalMs);
    window.addEventListener("focus", comeBack);
    document.addEventListener("visibilitychange", comeBack);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", comeBack);
      document.removeEventListener("visibilitychange", comeBack);
    };
  }, [enabled, intervalMs, attempt]);
  const invalidate = () => {
    epoch.current += 1;
  };
  /** Takes a read a person asked for elsewhere as the newest one; returns its read number. */
  const record = (next: DesktopCuaGrants | null) => {
    invalidate();
    settle(next, true);
    return readCount.current;
  };
  const retry = () => {
    setRetrying(true);
    setAttempt((current) => current + 1);
  };
  return {
    grants: state.grants,
    error: state.error,
    unanswered: state.unanswered,
    reads,
    record,
    invalidate,
    retry,
    retrying,
  };
}

const STEP_ICONS: Record<CuaPermission, ReactNode> = {
  accessibility: <MacAccessibilityIcon className="size-8 shrink-0 drop-shadow-sm" />,
  "screen-recording": <MacScreenRecordingIcon className="size-8 shrink-0 drop-shadow-sm" />,
};

/**
 * What a grant's row offers: the System Settings guide, or that it is allowed. Kept apart from
 * the row so the shared readiness list can place it in its grant slot.
 */
function CuaGrantAction({
  step,
  busy,
  onOpen,
}: {
  step: CuaGrantStep;
  busy: boolean;
  onOpen: (permission: CuaPermission) => void;
}) {
  if (step.state === "allowed")
    return (
      <span className="flex items-center gap-1 text-xs text-success">
        <CircleCheckIcon className="size-4" aria-hidden="true" />
        Allowed
      </span>
    );
  return (
    <Button
      size="xs"
      variant={step.state === "next" ? "default" : "outline"}
      disabled={busy || step.state === "later"}
      onClick={() => onOpen(step.id)}
    >
      {step.state === "waiting" ? "Open again" : "Open Settings"}
    </Button>
  );
}

export function CuaGrantSteps({
  grants,
  opened,
  busy,
  onOpen,
  onReveal,
}: {
  grants: CuaGrantHolder;
  /** The pane the person last opened from here. */
  opened: CuaPermission | null;
  busy: boolean;
  onOpen: (permission: CuaPermission) => void;
  onReveal?: (() => void) | undefined;
}) {
  const steps = cuaGrantSteps(grants, opened);
  const helper = grants.principal === "helper";
  return (
    <div className="space-y-3">
      {helper ? (
        <p className="text-muted-foreground">
          Agents work through <span className="font-medium text-foreground">{grants.name}</span>, a
          helper inside GOAT. Allow it in System Settings; GOAT itself does not need these
          permissions.
        </p>
      ) : null}
      <ol aria-label="Permissions" className="space-y-2">
        {steps.map((step, index) => (
          <li
            key={step.id}
            className={
              step.state === "later"
                ? "rounded-lg border px-3 py-2 opacity-60"
                : "rounded-lg border px-3 py-2"
            }
          >
            <div className="flex items-center gap-3">
              {STEP_ICONS[step.id]}
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  <span className="text-muted-foreground">Step {index + 1} · </span>
                  {step.title}
                  <span className="sr-only">
                    {step.state === "allowed"
                      ? " (allowed)"
                      : step.state === "waiting"
                        ? " (waiting for you)"
                        : step.state === "next"
                          ? " (to do now)"
                          : " (after the step above)"}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">{step.description}</p>
              </div>
              <CuaGrantAction step={step} busy={busy} onOpen={onOpen} />
            </div>
            {step.state === "waiting" ? (
              <div className="mt-2">
                <CuaGrantWaitingHint name={grants.name} helper={helper} />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {helper ? (
        <div className="rounded-lg border px-3 py-2">
          <p className="font-medium">Input Monitoring (optional)</p>
          <p className="text-xs text-muted-foreground">Lets you press Esc to stop the agent.</p>
          <p className="text-xs text-muted-foreground">
            In System Settings → Privacy &amp; Security → Input Monitoring, allow {grants.name}.
          </p>
        </div>
      ) : null}
      <CuaGrantTroubleshooting grants={grants} onReveal={onReveal} />
    </div>
  );
}

/**
 * Setup's state while the app that holds the grants does not answer: why, and a way to ask
 * again. It replaces the grant steps, since nothing was heard about the grants themselves.
 */
export function CuaUnansweredNotice({
  unanswered,
  retrying,
  onRetry,
}: {
  unanswered: CuaUnanswered;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border px-3 py-2">
      <p role="alert" className="font-medium text-destructive">
        {unanswered.message}
      </p>
      <p className="text-xs text-muted-foreground">
        GOAT could not read the permissions, so this does not mean one is missing. Allowing them
        again in System Settings will not change it.
        {unanswered.reason === "refused"
          ? null
          : " GOAT keeps asking and goes on by itself once it gets an answer."}
      </p>
      <Button size="xs" variant="outline" disabled={retrying} onClick={onRetry}>
        {retrying ? "Asking…" : "Try again"}
      </Button>
    </div>
  );
}

/** Remedies for a grant that stays off, folded away until the person asks. */
export function CuaGrantTroubleshooting({
  grants,
  onReveal,
}: {
  grants: CuaGrantHolder;
  onReveal?: (() => void) | undefined;
}) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRightIcon
          className="size-3.5 transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
        Still not allowed?
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-xs text-muted-foreground">
          {cuaGrantTroubleshooting(grants).map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
        <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
          {grants.bundlePath ? (
            <p>
              GOAT is checking the copy at{" "}
              <span className="break-all font-mono">{grants.bundlePath}</span>.
            </p>
          ) : null}
          <p>
            {grants.bundlePath ? "Its bundle ID is" : "GOAT is checking the app with bundle ID"}{" "}
            <span className="font-mono">{grants.bundleId}</span>.
          </p>
        </div>
        {onReveal ? (
          <div className="mt-2">
            <Button size="xs" variant="outline" onClick={onReveal}>
              Show {grants.name} in Finder
            </Button>
          </div>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** The waiting hint under a grant whose pane is open, the same words as the setup steps. */
function CuaGrantWaitingHint({ name, helper }: { name: string; helper: boolean }) {
  return (
    <p role="status" className="text-xs text-muted-foreground">
      Drag {name} from the panel into the list, then turn on its switch. Already on but still
      waiting? The row that is on may be for another copy
      {helper
        ? `: GOAT and GOAT Nightly each list their own ${name}, and only the one for the app you are using counts.`
        : "."}{" "}
      “Still not allowed?” below shows which copy GOAT is checking.
    </p>
  );
}
