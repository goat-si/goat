import type { DesktopCuaGrants } from "@goat/contracts";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { ChevronRightIcon, CircleCheckIcon } from "~/components/solar";
import { MacAccessibilityIcon, MacScreenRecordingIcon } from "../Icons";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  cuaGrantSteps,
  cuaGrantTroubleshooting,
  type CuaGrantHolder,
  type CuaGrantStep,
  type CuaPermission,
} from "./CuaSetupDialog.logic";

/**
 * The grants of the app computer use runs as, read again while setup is open. Each read asks a
 * fresh helper process, so a switch turned on in System Settings shows up on the next check.
 * record and invalidate start a new epoch, so a read that began before them is dropped when it
 * lands; reads counts the successful reads, so a caller can wait for one newer than its own.
 */
export function useCuaGrants(
  check: () => Promise<DesktopCuaGrants>,
  enabled: boolean,
  intervalMs = 1500,
) {
  const [grants, setGrants] = useState<DesktopCuaGrants | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const epoch = useRef(0);
  const readCount = useRef(0);
  const checkLatest = useEffectEvent(check);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let checking = false;
    // A helper that cannot be used stays that way, so only the person coming back asks again.
    let unusable = false;
    const refresh = async () => {
      if (disposed || checking || document.visibilityState === "hidden") return;
      checking = true;
      const started = epoch.current;
      await checkLatest().then(
        (next) => {
          unusable = next.principal === "unusable";
          if (disposed || started !== epoch.current) return;
          setGrants(next);
          setError(null);
          readCount.current += 1;
          setReads(readCount.current);
        },
        () => {
          if (!disposed && started === epoch.current)
            setError("Could not check permissions. We'll try again automatically.");
        },
      );
      checking = false;
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (!unusable) void refresh();
    }, intervalMs);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled, intervalMs]);
  const invalidate = () => {
    epoch.current += 1;
  };
  /** Takes a read made elsewhere as the newest one; returns its read number. */
  const record = (next: DesktopCuaGrants) => {
    invalidate();
    setGrants(next);
    setError(null);
    readCount.current += 1;
    setReads(readCount.current);
    return readCount.current;
  };
  return { grants, error, reads, record, invalidate };
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
                <CuaGrantWaitingHint name={grants.name} />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <CuaGrantTroubleshooting grants={grants} onReveal={onReveal} />
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
        {grants.bundlePath ? (
          <p className="mt-2 text-xs text-muted-foreground">
            This copy is at <span className="break-all font-mono">{grants.bundlePath}</span>.
          </p>
        ) : null}
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
function CuaGrantWaitingHint({ name }: { name: string }) {
  return (
    <p role="status" className="text-xs text-muted-foreground">
      Drag {name} from the panel into the list, then turn on its switch. Already on but still
      waiting? That row belongs to an older copy: in both Accessibility and Screen & System Audio
      Recording, remove every {name} row with the − button, then drag this copy in again.
    </p>
  );
}
