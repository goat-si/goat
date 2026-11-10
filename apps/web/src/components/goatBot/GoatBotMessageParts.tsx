import type { GoatBotActivity, GoatBotAttachmentLabel } from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";

import { useAssetUrlState } from "~/assets/assetUrls";
import { BellIcon, PaperclipIcon } from "~/components/solar";

import { GoatBotFace } from "./GoatBotFace";

/** The activity line also names the followed work. */
export type GoatBotTimelineActivity = GoatBotActivity & {
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

/**
 * One line for what GOAT Bot is doing: its still face and the step it is on, then the work it
 * follows. Nothing here moves; a new step replaces the text.
 */
export function GoatBotActivityLine({ activity }: { readonly activity: GoatBotTimelineActivity }) {
  const waiting = activity.state === "working" && activity.text.startsWith("Waiting");
  const title =
    activity.state === "working" && activity.title !== activity.text ? activity.title : undefined;
  return (
    <div className="flex min-h-8 max-w-[44rem] min-w-0 items-center gap-2 ps-1 text-sm leading-5 text-muted-foreground">
      <GoatBotFace
        state={activity.state === "reading" ? "reading" : waiting ? "waiting" : "working"}
        className="size-5 shrink-0 text-foreground"
      />
      <p className="min-w-0 truncate">
        <span role="status" aria-live="polite" aria-atomic="true">
          {activity.text}
        </span>
        {title === undefined ? null : <span className="opacity-70">{" · " + title}</span>}
      </p>
    </div>
  );
}
