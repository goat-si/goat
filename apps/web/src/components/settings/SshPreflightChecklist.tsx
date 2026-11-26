import { msg, useGT, useMessages } from "gt-react";
import { useSshPreflightMessages } from "./sshPreflightMessages";
import {
  SSH_PREFLIGHT_STEP_ORDER,
  type SshPreflightReport,
  type SshPreflightStepId,
} from "@goat/contracts";
import { useState } from "react";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  ClockIcon,
  CopyIcon,
  ShieldQuestionIcon,
} from "~/components/solar";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";

const STEP_LABELS: Record<SshPreflightStepId, string> = {
  reachability: msg("Reachability"),
  host_key: msg("Host key"),
  key_auth: msg("SSH key sign-in"),
  platform: msg("Operating system"),
  disk: msg("Disk space"),
  runtime: msg("GOAT runtime"),
};
const STEP_STATES = {
  passed: { Icon: CircleCheckIcon, label: msg("Passed"), tone: "text-success-foreground" },
  warning: { Icon: CircleAlertIcon, label: msg("Warning"), tone: "text-warning-foreground" },
  needs_review: {
    Icon: ShieldQuestionIcon,
    label: msg("Needs review"),
    tone: "text-warning-foreground",
  },
  failed: { Icon: CircleXIcon, label: msg("Failed"), tone: "text-destructive" },
  skipped: { Icon: CircleDashedIcon, label: msg("Skipped"), tone: "text-muted-foreground" },
};

function SetupCommand({ command }: { readonly command: string }) {
  const gt = useGT();
  const [error, setError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "setup command",
    onCopy: () => setError(null),
    onError: () => setError(gt("Could not copy the setup command to the clipboard.")),
  });
  return (
    <div className="space-y-1">
      <div className="flex items-start gap-2 rounded-md bg-muted p-2">
        <code className="min-w-0 flex-1 select-text whitespace-pre-wrap break-all font-mono text-xs">
          {command}
        </code>
        <Button variant="ghost" size="xs" onClick={() => copyToClipboard(command, undefined)}>
          <CopyIcon className="size-3.5" />
          {isCopied ? gt("Copied") : gt("Copy command")}
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

export function SshPreflightChecklist({
  report,
  checking,
  disabled,
  onCheckAgain,
  onForget,
}: {
  readonly report: SshPreflightReport | null;
  readonly checking: boolean;
  readonly disabled: boolean;
  readonly onCheckAgain: () => void;
  /** Present when GOAT pinned this alias but it never became a saved connection. */
  readonly onForget?: (() => void) | undefined;
}) {
  const gt = useGT();
  const m = useMessages();
  const reportText = useSshPreflightMessages();
  return (
    <section aria-label={gt("SSH preflight")} aria-busy={checking} className="space-y-3">
      <ol className="space-y-3">
        {SSH_PREFLIGHT_STEP_ORDER.map((id) => {
          const step = checking
            ? undefined
            : report?.steps.find((candidate) => candidate.id === id);
          const { Icon, label, tone } = checking
            ? { Icon: ClockIcon, label: msg("Checking…"), tone: "text-muted-foreground" }
            : STEP_STATES[step?.state ?? "skipped"];
          return (
            <li key={id} className="flex items-start gap-2 text-sm">
              <span className={tone}>
                <Icon className="mt-0.5 size-4" aria-hidden="true" />
                <span className="sr-only">{m(label)}</span>
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-medium">{m(STEP_LABELS[id])}</p>
                <p className="text-xs text-muted-foreground">
                  {checking ? gt("Checking…") : step ? reportText(step.summary) : gt("Not checked")}
                </p>
                {step?.detail ? (
                  <p className="text-xs text-muted-foreground">{reportText(step.detail)}</p>
                ) : null}
                {step?.fix ? <p className="text-xs">{reportText(step.fix.instruction)}</p> : null}
                {step?.fix?.command ? <SetupCommand command={step.fix.command} /> : null}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={disabled || checking} onClick={onCheckAgain}>
          {gt("Check again")}
        </Button>
        {onForget ? (
          <Button
            variant="ghost-destructive"
            size="sm"
            disabled={disabled || checking}
            onClick={onForget}
          >
            {gt("Forget host")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
