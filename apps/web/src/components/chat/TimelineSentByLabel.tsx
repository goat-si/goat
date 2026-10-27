import type { EnvironmentId, MessageId, ThreadId } from "@goat/contracts";
import { ArrowUpRightIcon, MessagesSquareIcon } from "~/components/solar";

import { randomUUID } from "../../lib/utils";
import type { OpenThreadOptions } from "../../lib/sentFromNavigation";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type SentBySender =
  /** A thread this environment holds; the name opens it. */
  | { readonly kind: "open"; readonly threadId: ThreadId; readonly title: string }
  | { readonly kind: "deleted"; readonly title: string }
  /** A thread on another machine, as that machine named it; opens only while it is connected. */
  | {
      readonly kind: "remote";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly title: string;
      readonly connected: boolean;
    }
  /** Recorded, but this app holds no such thread. */
  | { readonly kind: "unknown" }
  /** Delivered without a sender, such as a send from another machine. */
  | { readonly kind: "unrecorded" };

const UNAVAILABLE_REASON: Record<Exclude<SentBySender["kind"], "open" | "remote">, string> = {
  deleted: "This thread was deleted",
  unknown: "That thread isn't available in this app",
  unrecorded: "The sending thread wasn't recorded",
};

/**
 * Names the thread that sent a message into this one. The name opens that thread at the call
 * that sent it; a thread that cannot be opened stays plain and says why on hover.
 */
export function TimelineSentByLabel(props: {
  readonly sender: SentBySender;
  readonly destination: { readonly threadId: ThreadId; readonly messageId: MessageId } | null;
  readonly machine: string | null;
  readonly sentAt: string;
  readonly onOpenThread: (threadId: ThreadId, options?: OpenThreadOptions) => void;
}) {
  const { sender } = props;
  const name =
    sender.kind === "open" || sender.kind === "deleted" || sender.kind === "remote"
      ? sender.title
      : null;
  const target =
    sender.kind === "open" || (sender.kind === "remote" && sender.connected) ? sender : null;
  const detail =
    target !== null
      ? [props.machine, props.sentAt].filter((part) => part !== null).join(" · ")
      : sender.kind === "remote"
        ? `Connect ${props.machine ?? "that machine"} to open this thread`
        : sender.kind === "open"
          ? ""
          : UNAVAILABLE_REASON[sender.kind];
  const nameNode =
    target !== null ? (
      <TooltipTrigger
        render={
          <InlineButton
            tone="muted"
            aria-label={`Open ${target.title}`}
            onClick={() =>
              props.onOpenThread(target.threadId, openOptions(target, props.destination))
            }
            className="group/sender inline-flex min-w-0 max-w-full items-center"
          />
        }
      >
        <span className="truncate">{target.title}</span>
        <ArrowUpRightIcon
          aria-hidden
          className="hidden size-3 shrink-0 group-hover/sender:inline group-focus-visible/sender:inline"
        />
      </TooltipTrigger>
    ) : (
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="min-w-0 truncate rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-ring"
          />
        }
      >
        {name === null ? "Sent from another thread" : name}
      </TooltipTrigger>
    );
  return (
    <p
      className="me-1 flex min-w-0 max-w-[80%] items-center gap-1 whitespace-pre text-2xs text-muted-foreground/70"
      data-user-message-attribution="agent"
    >
      <MessagesSquareIcon aria-hidden className="size-3 shrink-0" />
      {sender.kind === "unrecorded" || sender.kind === "unknown" ? (
        <Tooltip>
          {nameNode}
          <TooltipPopup>{detail}</TooltipPopup>
        </Tooltip>
      ) : (
        <>
          <span className="shrink-0">Sent by</span>{" "}
          <Tooltip>
            {nameNode}
            <TooltipPopup>{detail}</TooltipPopup>
          </Tooltip>{" "}
          <span className="shrink-0">from another thread</span>
        </>
      )}
    </p>
  );
}

function openOptions(
  target: Extract<SentBySender, { kind: "open" | "remote" }>,
  destination: { readonly threadId: ThreadId; readonly messageId: MessageId } | null,
): OpenThreadOptions {
  const remote = target.kind === "remote" ? target.environmentId : undefined;
  return {
    ...(remote === undefined ? {} : { environmentId: remote }),
    ...(destination === null
      ? {}
      : {
          sentFrom: {
            ...destination,
            senderThreadId: target.threadId,
            ...(remote === undefined ? {} : { senderEnvironmentId: remote }),
            activation: randomUUID(),
          },
        }),
  };
}
