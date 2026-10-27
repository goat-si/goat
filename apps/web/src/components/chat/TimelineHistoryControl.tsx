import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";

export function TimelineHistoryControl(props: MessagesTimelineHistoryControls) {
  if (!props.hasMoreHistory && props.error === null) {
    return null;
  }
  return (
    <div className="messages-timeline-row-frame">
      <div className="chat-content-lane flex flex-col gap-1.5 pb-2">
        {props.hasMoreHistory ? (
          <button
            type="button"
            disabled={props.loading}
            aria-label="Load earlier turns"
            onClick={() => props.onLoadEarlier()}
            className="flex w-full cursor-pointer items-center gap-3 py-1.5 text-muted-foreground text-xs hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
          >
            <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
            <span className="shrink-0">
              {props.loading ? "Loading earlier turns…" : "Load earlier turns"}
            </span>
            <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
          </button>
        ) : null}
        {props.error !== null ? (
          <p role="status" className="text-center text-muted-foreground text-xs">
            {props.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
