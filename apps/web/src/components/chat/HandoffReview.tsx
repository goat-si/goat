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
}) {
  const { human } = props;
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm">
      <p className="whitespace-pre-wrap text-foreground">{human.location}</p>
      {human.fingerprint ? (
        <>
          <p>If your server provider shows a host key, check that it matches.</p>
          <code className="select-all break-all font-mono">{human.fingerprint}</code>
        </>
      ) : null}
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
          <p>
            Run this in your own terminal on the computer that runs GOAT. If the server asks for a
            password, enter it there; GOAT never sees it.
          </p>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-3">
            <code className="select-all">{human.command}</code>
          </pre>
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Only you see these details. The agent never does.
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
