import type { EnvironmentId, NoteThreadLink } from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { MessageSquareIcon, XIcon } from "~/components/solar";
import { Button } from "../components/ui/button";
import { useQuietThreadShell } from "../state/entities";
import { noteThreadPresentation } from "./noteThread";

/** A thread started from the note (work) or linked to it for reference (related). */
export function NoteLinkedThread(props: {
  thread: NoteThreadLink;
  destination: EnvironmentId | undefined;
  related?: boolean;
  onUnlink?: (() => void) | undefined;
}) {
  const { thread, destination } = props;
  const shell = useQuietThreadShell(
    destination ? { environmentId: destination, threadId: thread.threadId } : null,
  );
  const presentation = noteThreadPresentation(thread, shell?.title);
  return (
    <li className="flex items-start gap-2.5 rounded-lg px-2 py-2 text-sm hover:bg-accent/40">
      <MessageSquareIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        {destination ? (
          <Link
            className="font-medium underline-offset-2 hover:underline"
            to="/$environmentId/$threadId"
            params={{ environmentId: destination, threadId: thread.threadId }}
          >
            {presentation.label}
          </Link>
        ) : (
          <>
            <span className="font-medium">{presentation.label}</span>
            <p className="text-xs text-muted-foreground">
              Connect {thread.host ?? "this hub"} in Settings → Connections to open it
            </p>
          </>
        )}
        <p className="text-xs text-muted-foreground">
          {props.related ? "Linked from the thread" : presentation.status}
        </p>
        {!props.related && thread.lastResult?.summary && (
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
            {thread.lastResult.summary}
          </p>
        )}
      </div>
      {props.onUnlink && (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Unlink thread"
          onClick={props.onUnlink}
        >
          <XIcon aria-hidden />
        </Button>
      )}
    </li>
  );
}
