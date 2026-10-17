import type { HandoffHuman } from "@goat/contracts";
import { Button } from "../ui/button";

/** Private instructions shared by thread review and the Desktop host trust screen. */
export function HandoffReview(props: {
  human: HandoffHuman;
  busy: boolean;
  allowed: boolean;
  approveLabel: string;
  onApprove: () => void;
  onDecline?: () => void;
  onCancel?: () => void;
  cancelLabel?: string;
  includeRequired?: boolean;
}) {
  const { human } = props;
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm">
      <p className="whitespace-pre-wrap text-foreground">{human.location}</p>
      {human.fingerprint ? (
        <>
          <p>
            Check this fingerprint against the host key from your server provider before approving.
          </p>
          <code className="select-all break-all font-mono">{human.fingerprint}</code>
        </>
      ) : null}
      {props.includeRequired ? <p>GOAT will add one Include line to ~/.ssh/config.</p> : null}
      {human.url ? (
        <a
          className="break-all text-primary underline"
          href={human.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open sign-in page
        </a>
      ) : null}
      {human.userCode ? (
        <p>
          Enter code: <code className="select-all font-mono">{human.userCode}</code>
        </p>
      ) : null}
      {human.command ? (
        <>
          <p>Run this on the machine that runs this environment, in your own terminal:</p>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-3">
            <code className="select-all">{human.command}</code>
          </pre>
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">
        These details stay private and are never sent to the agent.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={props.busy || !props.allowed} onClick={props.onApprove}>
          {props.approveLabel}
        </Button>
        {props.onDecline ? (
          <Button
            variant="ghost-muted"
            disabled={props.busy || !props.allowed}
            onClick={props.onDecline}
          >
            Decline
          </Button>
        ) : null}
        {props.onCancel ? (
          <Button
            variant="ghost-muted"
            disabled={props.busy || !props.allowed}
            onClick={props.onCancel}
          >
            {props.cancelLabel ?? "Cancel request"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
