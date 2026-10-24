import type { DesktopCuaGrants, DesktopCuaVerification } from "@goat/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useCuaGrants } from "./CuaGrantSteps";
import {
  CUA_PERMISSIONS,
  cuaGranted,
  cuaNeedsRelaunch,
  cuaVerificationRows,
  type CuaGrantHolder,
  type CuaPermission,
} from "./CuaSetupDialog.logic";

/**
 * Where the one-switch setup is. saving: the setting is being written. checking: this Mac's
 * grants are read once. granting: a grant is missing; setup resumes on a read newer than
 * afterRead. verifying: the helper restarts and proves a real capture and tree read. ready:
 * that proof passed in this session.
 */
export type ComputerUseSetupPhase =
  | { readonly step: "idle" }
  | { readonly step: "saving" }
  | { readonly step: "checking" }
  | { readonly step: "granting"; readonly afterRead: number }
  | { readonly step: "verifying" }
  | { readonly step: "ready" }
  | { readonly step: "failed"; readonly message: string; readonly relaunch: boolean };

export interface ComputerUseSetupActions {
  /** Writes the setting; resolves to an error message when it could not be saved. */
  readonly save: (patch: { readonly enableCua: boolean }) => Promise<string | null>;
  readonly checkGrants: () => Promise<DesktopCuaGrants>;
  /** Restarts the helper and proves it can capture a window and read its controls. */
  readonly verify: () => Promise<DesktopCuaVerification>;
  /** Opens the System Settings pane with the panel to drag the helper into its list. */
  readonly openGuide: (permission: CuaPermission) => Promise<void>;
  readonly relaunch?: (() => Promise<void>) | undefined;
}

const UNREACHABLE: DesktopCuaVerification = {
  verified: false,
  steps: [{ id: "restart", ok: false, detail: "Could not reach computer use." }],
};
const SAVE_FAILED = "Could not save the setting. Try again.";

const failed = (message: string, relaunch = false): ComputerUseSetupPhase => ({
  step: "failed",
  message,
  relaunch,
});

function verificationFailure(result: DesktopCuaVerification): string {
  const row = cuaVerificationRows(result).find((candidate) => candidate.state === "failed");
  if (row?.detail) return `Setup failed: ${row.detail}`;
  return row ? `Setup failed: “${row.label}” did not pass.` : "Setup failed.";
}

type EnableChoiceResult =
  | { readonly kind: "saved" }
  | { readonly kind: "failed"; readonly message: string; readonly latest: boolean }
  | { readonly kind: "superseded" };

/**
 * The person's latest On/Off choice. Saves go out in click order, each after the previous one
 * answered, on a queue that outlives the panel, so the host always ends on the last choice. The
 * switch shows that choice until its save answers; after that the settings stream wins as soon
 * as it shows the choice or moves at all. Settings carry no generation, so an older echo can
 * still arrive afterwards; it can flicker the switch but never cancels setup.
 */
function useEnableChoice(enabled: boolean, save: (value: boolean) => Promise<string | null>) {
  const [desired, setDesired] = useState<{
    readonly id: number;
    readonly value: boolean;
    /** What the stream showed when the save answered; null while the save is out. */
    readonly streamedAtSave: boolean | null;
  } | null>(null);
  const latest = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const streamed = useRef(enabled);
  useEffect(() => {
    streamed.current = enabled;
  }, [enabled]);
  if (
    desired !== null &&
    desired.streamedAtSave !== null &&
    (desired.value === enabled || desired.streamedAtSave !== enabled)
  )
    setDesired(null);

  const choose = async (value: boolean): Promise<EnableChoiceResult> => {
    latest.current += 1;
    const id = latest.current;
    setDesired({ id, value, streamedAtSave: null });
    const saved = queue.current.then(() => save(value)).catch(() => SAVE_FAILED);
    queue.current = saved;
    const failure = await saved;
    if (id !== latest.current) return { kind: "superseded" };
    if (failure !== null) {
      setDesired(null);
      return { kind: "failed", message: failure, latest: true };
    }
    setDesired((current) =>
      current?.id === id ? { ...current, streamedAtSave: streamed.current } : current,
    );
    return { kind: "saved" };
  };

  return { on: desired?.value ?? enabled, choose };
}

/**
 * Turning computer use on runs the whole setup in order: save the setting, read this Mac's
 * grants, wait in System Settings for any that are missing, then restart and verify the helper.
 * Only the Mac that runs the host can read and prove its grants; elsewhere saving is the setup.
 */
export function useComputerUseAutoSetup({
  enabled,
  localMac,
  hostRejects,
  actions,
}: {
  readonly enabled: boolean;
  readonly localMac: boolean;
  /**
   * The host reports a failure or a blocked grant, helper or capture step. A failure carries no
   * generation that would prove it older than this session's check, so it ends that proof.
   */
  readonly hostRejects: boolean;
  readonly actions: ComputerUseSetupActions;
}) {
  const [phase, setPhase] = useState<ComputerUseSetupPhase>({ step: "idle" });
  const choice = useEnableChoice(enabled, (value) => actions.save({ enableCua: value }));
  const [opened, setOpened] = useState<CuaPermission | null>(null);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Each run gets a number, so a run that Off, unmount or a later run replaced reports nothing.
  const run = useRef(0);
  // The check in flight. A run that Off replaced can still be restarting the helper, so a later
  // run waits for it and then proves the helper again for itself.
  const inflight = useRef<Promise<DesktopCuaVerification> | null>(null);
  const on = choice.on;
  const busy = phase.step === "saving" || phase.step === "checking" || phase.step === "verifying";
  // Each read starts a helper process, so it pauses while setup runs its own, rechecks quickly
  // while the person is in System Settings, and otherwise slowly to catch a revoked grant.
  const polled = useCuaGrants(
    actions.checkGrants,
    localMac && on && !busy,
    phase.step === "granting" ? 1500 : 15_000,
  );
  const grants = localMac ? polled.grants : null;
  const holder: CuaGrantHolder | null = grants && grants.principal !== "unusable" ? grants : null;
  const missing = holder ? (CUA_PERMISSIONS.find((id) => !cuaGranted(holder, id)) ?? null) : null;

  if (opened !== null && holder !== null && cuaGranted(holder, opened)) setOpened(null);
  // A grant revoked in System Settings, or one still missing when the page opens, asks again.
  if (on && missing !== null && (phase.step === "idle" || phase.step === "ready"))
    setPhase({ step: "granting", afterRead: polled.reads });
  // Only a new check restores Ready once the host has reported against it.
  if (phase.step === "ready" && hostRejects) setPhase({ step: "idle" });
  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );

  const verifyNow = async (id: number) => {
    setPhase({ step: "verifying" });
    while (inflight.current !== null) {
      await inflight.current;
      if (id !== run.current) return;
    }
    const attempt = actions.verify().catch(() => UNREACHABLE);
    inflight.current = attempt;
    const result = await attempt;
    if (inflight.current === attempt) inflight.current = null;
    if (id !== run.current) return;
    setPhase(
      result.verified
        ? { step: "ready" }
        : failed(
            verificationFailure(result),
            actions.relaunch !== undefined &&
              cuaNeedsRelaunch({ grants: holder, opened, verification: result }),
          ),
    );
  };
  // Setup goes on by itself once a read made after the prompt shows every grant on.
  const resume =
    on &&
    phase.step === "granting" &&
    polled.reads > phase.afterRead &&
    holder !== null &&
    missing === null;
  const resumeVerify = useEffectEvent(() => {
    run.current += 1;
    void verifyNow(run.current);
  });
  useEffect(() => {
    if (resume) resumeVerify();
  }, [resume]);

  const start = async () => {
    run.current += 1;
    const id = run.current;
    polled.invalidate();
    setNotice(null);
    setOpened(null);
    setPhase({ step: "saving" });
    const saved = await choice.choose(true);
    if (id !== run.current || saved.kind === "superseded") return;
    if (saved.kind === "failed") {
      setPhase(failed(saved.message));
      return;
    }
    if (!localMac) {
      setPhase({ step: "idle" });
      return;
    }
    setPhase({ step: "checking" });
    const checked = await actions.checkGrants().catch(() => null);
    if (id !== run.current) return;
    if (checked === null) {
      setPhase(failed("Could not check permissions on this Mac."));
      return;
    }
    const read = polled.record(checked);
    if (checked.principal === "unusable") {
      setPhase(failed(checked.message));
      return;
    }
    if (CUA_PERMISSIONS.some((permission) => !cuaGranted(checked, permission))) {
      setPhase({ step: "granting", afterRead: read });
      return;
    }
    await verifyNow(id);
  };

  const stop = async () => {
    run.current += 1;
    polled.invalidate();
    setNotice(null);
    setOpened(null);
    setPhase({ step: "idle" });
    const saved = await choice.choose(false);
    // The setting is still on, so the switch shows that again and Off can be retried.
    if (saved.kind === "failed" && saved.latest)
      setNotice("Could not turn off computer use. Try again.");
  };

  const openGrant = (permission: CuaPermission) => {
    // A pane opened for a run that Off or a later run replaced reports nothing.
    const id = run.current;
    setOpening(true);
    setNotice(null);
    void actions.openGuide(permission).then(
      () => {
        setOpening(false);
        if (id === run.current) setOpened(permission);
      },
      () => {
        setOpening(false);
        if (id === run.current) setNotice("Could not open System Settings. Try again.");
      },
    );
  };

  const relaunch = actions.relaunch
    ? () => {
        setNotice(null);
        void actions
          .relaunch?.()
          .catch(() => setNotice("Could not reopen GOAT. Quit it and open it again."));
      }
    : undefined;

  return {
    on,
    phase,
    busy,
    holder,
    unusable: grants?.principal === "unusable" ? grants.message : null,
    missing,
    opened,
    opening,
    notice,
    pollError: localMac ? polled.error : null,
    /** Quitting and reopening GOAT is the remedy for an app that holds its own grants. */
    needsRelaunch:
      relaunch !== undefined && cuaNeedsRelaunch({ grants: holder, opened, verification: null }),
    start,
    stop,
    openGrant,
    relaunch,
  };
}

export type ComputerUseAutoSetup = ReturnType<typeof useComputerUseAutoSetup>;
