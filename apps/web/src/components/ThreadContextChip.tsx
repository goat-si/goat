import { scopeProjectRef } from "@goat/client-runtime/environment";
import type { ProjectId, ThreadContextRecord } from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { MessagesSquareIcon } from "~/components/solar";

import { useProject, useThreadShell } from "~/state/entities";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { ProjectFavicon } from "./ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ThreadContextChip(props: {
  record: Pick<ThreadContextRecord, "environmentId" | "threadId" | "title" | "host">;
  copyMarkdown?: string;
  state?: "readable" | "unavailable" | "invalid";
  /** A thread this client holds no shell for, as the server named it; null without a project. */
  projectId?: ProjectId | null;
}) {
  const { environmentId, threadId } = props.record;
  const shell = useThreadShell({ environmentId, threadId });
  const projectId = shell?.projectId ?? props.projectId ?? null;
  const project = useProject(projectId ? scopeProjectRef(environmentId, projectId) : null);
  const title = shell?.title?.trim() || props.record.title;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="thread"
            {...(props.state === "invalid" || props.state === "unavailable"
              ? { state: props.state }
              : {})}
            render={<Link to="/$environmentId/$threadId" params={{ environmentId, threadId }} />}
            aria-label={`Thread, ${title}`}
            data-markdown-copy={props.copyMarkdown}
          >
            {project ? (
              <ProjectFavicon project={project} className="size-[1em] self-center" />
            ) : (
              <MessagesSquareIcon />
            )}
            <ContextChipLabel>
              {title}
              {props.record.host ? ` · ${props.record.host}` : ""}
              {props.state === "unavailable" ? " · Host not connected" : ""}
            </ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">
        {props.state === "invalid"
          ? "On another machine, so this machine's agent can't read it. Remove it or switch back to send."
          : props.state === "unavailable"
            ? `Host ${props.record.host} is not connected. The connection is unavailable or reconnecting; the agent can still try reading it through this host.`
            : shell || props.projectId !== undefined
              ? "Open thread"
              : "Thread no longer available"}
      </TooltipPopup>
    </Tooltip>
  );
}
