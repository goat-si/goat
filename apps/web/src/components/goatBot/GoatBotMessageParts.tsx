import type { GoatBotActivity, GoatBotAttachmentLabel } from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";
import { useState, useSyncExternalStore } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import {
  BellIcon,
  ChevronDownIcon,
  CircleDotIcon,
  ClockIcon,
  EyeIcon,
  PaperclipIcon,
} from "~/components/solar";
import { cn } from "~/lib/utils";
import { formatElapsedDurationLabel } from "~/timestampFormat";

import { Button } from "../ui/button";

/** The activity line also shows how long the followed work has run and, opened, what it is. */
export type GoatBotTimelineActivity = GoatBotActivity & {
  readonly since?: string;
  readonly title?: string;
};

/** Opens a run of messages the bot sent on its own, so an update never reads as a reply. */
export function GoatBotUpdateLabel({ name }: { readonly name: string }) {
  return (
    <div className="ms-3.5 mb-1 flex min-w-0 items-center gap-1.5 text-xs leading-5 text-muted-foreground">
      <BellIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{`${name} · Update`}</span>
    </div>
  );
}

/** A message's time, shown beside it on hover or focus; stamps between groups carry it otherwise. */
export function GoatBotMessageTime({
  id,
  createdAt,
  time,
}: {
  readonly id: string;
  readonly createdAt: string;
  readonly time: string;
}) {
  return (
    <time
      id={id}
      dateTime={createdAt}
      className="shrink-0 pb-1.5 text-2xs leading-4 text-muted-foreground tabular-nums opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-visible/message:opacity-100"
    >
      {time}
    </time>
  );
}

/** Files a person sent: images as thumbnails once their address is known, others by name. */
export function GoatBotSentAttachments({
  attachments,
  environmentId,
}: {
  readonly attachments: ReadonlyArray<GoatBotAttachmentLabel>;
  readonly environmentId: EnvironmentId | null;
}) {
  return (
    <div className="flex max-w-[min(80%,35rem)] flex-wrap justify-end gap-1.5">
      {attachments.map((file) =>
        file.type === "image" ? (
          <GoatBotSentImage key={file.id} file={file} environmentId={environmentId} />
        ) : (
          <GoatBotSentFile key={file.id} name={file.name} />
        ),
      )}
    </div>
  );
}

function GoatBotSentImage({
  file,
  environmentId,
}: {
  readonly file: GoatBotAttachmentLabel;
  readonly environmentId: EnvironmentId | null;
}) {
  const state = useAssetUrlState(environmentId, { _tag: "attachment", attachmentId: file.id });
  if (state._tag !== "Success") return <GoatBotSentFile name={file.name} />;
  return (
    <img
      src={state.url}
      alt={file.name}
      loading="lazy"
      decoding="async"
      className="h-40 max-w-60 rounded-2xl border border-border object-cover"
    />
  );
}

function GoatBotSentFile({ name }: { readonly name: string }) {
  return (
    <span className="flex max-w-full min-w-0 items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm text-foreground">
      <PaperclipIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  );
}

const ELAPSED_TICK_MS = 1_000;

/** "12s", "3m": refreshed each second, re-rendering only when the label changes. */
function useElapsedLabel(since: string | null): string | null {
  const start = since === null ? Number.NaN : Date.parse(since);
  const subscribe = (onChange: () => void) => {
    if (Number.isNaN(start)) return () => {};
    const timer = setInterval(onChange, ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  };
  return useSyncExternalStore(
    subscribe,
    () => (since === null || Number.isNaN(start) ? null : formatElapsedDurationLabel(since)),
    () => null,
  );
}

/**
 * One line for what GOAT Bot is doing: a still icon, what it says, and for how long. Work it
 * follows opens to show which task that is. Nothing here moves; the label is the progress.
 */
export function GoatBotActivityLine({
  activity,
  since,
}: {
  readonly activity: GoatBotTimelineActivity;
  readonly since: string | null;
}) {
  const [open, setOpen] = useState(false);
  const elapsed = useElapsedLabel(since);
  const waiting = activity.state === "working" && activity.text.startsWith("Waiting");
  const Icon = activity.state === "reading" ? EyeIcon : waiting ? ClockIcon : CircleDotIcon;
  const title = activity.state === "working" ? (activity.title ?? null) : null;
  return (
    <div className="flex max-w-[44rem] min-w-0 flex-col text-sm leading-5 text-muted-foreground">
      <div className="flex min-h-8 min-w-0 items-center gap-2">
        <Icon
          aria-hidden
          className={cn("size-4 shrink-0", waiting ? "text-warning-foreground" : "text-foreground")}
        />
        <span role="status" aria-live="polite" aria-atomic="true" className="min-w-0 truncate">
          {activity.text}
        </span>
        {elapsed ? (
          <span aria-hidden className="shrink-0 tabular-nums">
            · {elapsed}
          </span>
        ) : null}
        {title !== null ? (
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-expanded={open}
            aria-label={open ? "Hide work details" : "Show work details"}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronDownIcon className={cn(open && "rotate-180")} />
          </Button>
        ) : null}
      </div>
      {open && title !== null ? <p className="ms-6 pb-1 break-words">{title}</p> : null}
    </div>
  );
}
