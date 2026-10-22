import type { EnvironmentId, NoteThreadLink } from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { useQuietThreadShell } from "../state/entities";
import { noteThreadPresentation } from "./noteThread";

export function NoteLinkedThread(props: {
  thread: NoteThreadLink;
  destination: EnvironmentId | undefined;
}) {
  const { thread, destination } = props;
  const shell = useQuietThreadShell(
    destination ? { environmentId: destination, threadId: thread.threadId } : null,
  );
  const presentation = noteThreadPresentation(thread, shell?.title);
  return (
    <li className="rounded-lg border border-border p-3 text-sm">
      {destination ? (
        <Link
          className="text-primary underline underline-offset-2"
          to="/$environmentId/$threadId"
          params={{ environmentId: destination, threadId: thread.threadId }}
        >
          {presentation.label}
        </Link>
      ) : (
        <>
          <span>{presentation.label}</span>
          <p className="text-xs text-muted-foreground">
            Connect {thread.host ?? "this hub"} in Settings → Connections to open it
          </p>
        </>
      )}
      <p>{presentation.status}</p>
      {thread.lastResult?.summary && (
        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
          {thread.lastResult.summary}
        </p>
      )}
    </li>
  );
}
