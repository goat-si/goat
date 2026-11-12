import { goatBotEventSubjectSpan, type GoatBotRow } from "@goat/client-runtime/goatBot";
import { ChannelTaskId } from "@goat/contracts";
import { Link } from "@tanstack/react-router";

import { CalendarIcon } from "~/components/solar";

import { goatBotSearch, useGoatBotMember } from "./goatBotMemberContext";

const CHIP =
  "mx-0.5 inline-flex items-center gap-1 rounded-full border border-border px-1.5 align-middle text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring";

/**
 * An event line's words, with the routine or task it names as a chip that opens it: a routine in
 * the bot's home, a task in its own view.
 */
export function GoatBotEventText({
  row,
  onOpenHome,
}: {
  readonly row: Extract<GoatBotRow, { kind: "event" }>;
  readonly onOpenHome?: (() => void) | undefined;
}) {
  const member = useGoatBotMember();
  const subject = row.subject;
  const span = goatBotEventSubjectSpan(row);
  if (subject === undefined || span === undefined) return row.text;
  const label = (subject.kind === "routine" ? "Open routine " : "Open task ") + subject.name;
  const chip =
    subject.kind === "task" ? (
      <Link
        to="/bot"
        search={{ task: ChannelTaskId.make(subject.id), ...goatBotSearch(member) }}
        aria-label={label}
        className={CHIP}
      >
        {subject.name}
      </Link>
    ) : onOpenHome === undefined ? null : (
      <button type="button" aria-label={label} onClick={onOpenHome} className={CHIP}>
        <CalendarIcon aria-hidden className="size-3" />
        {subject.name}
      </button>
    );
  if (chip === null) return row.text;
  return (
    <>
      {span.before}
      {chip}
      {span.after}
    </>
  );
}
