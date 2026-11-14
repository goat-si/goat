import { goatBotActivity, type GoatBotRow } from "@goat/client-runtime/goatBot";
import { useContext, useEffect, useState } from "react";

import { useGoatBotName } from "./goatBotMemberContext";
import { GoatBotActivityContext } from "./GoatBotTimeline";
import { useGoatBotReading } from "./useGoatBotFace";

const READING = goatBotActivity({ reading: true, task: null, worker: null });

/**
 * The chat's one live status: reading, working, waiting or paused, and done once the work the bot
 * was doing ends. It mounts with the chat, before any message, and stays empty until after its
 * first paint, so a screen reader hears its first words as a change.
 */
export function GoatBotActivityStatus({
  replyingSince,
  announcement = null,
}: {
  readonly replyingSince: string | null;
  readonly announcement?: {
    readonly sequence: number;
    readonly row: Extract<GoatBotRow, { kind: "bot" }>;
  } | null;
}) {
  const botName = useGoatBotName();
  const working = useContext(GoatBotActivityContext);
  const reading = useGoatBotReading(replyingSince);
  const readingKey = reading ? replyingSince : null;
  // Work stays outstanding while a reply to a newer message shows; its end still says "done".
  const [workOpen, setWorkOpen] = useState(false);
  // The reading shown when the work ended (null for none); undefined while nothing has ended.
  const [doneDuring, setDoneDuring] = useState<string | null | undefined>(undefined);
  if (working !== null && !workOpen) setWorkOpen(true);
  if (working !== null && doneDuring !== undefined) setDoneDuring(undefined);
  if (working === null && workOpen) {
    setWorkOpen(false);
    setDoneDuring(readingKey);
  }
  // A reply to a message sent after the work ended speaks for itself.
  if (doneDuring !== undefined && readingKey !== null && readingKey !== doneDuring)
    setDoneDuring(undefined);
  const [painted, setPainted] = useState(false);
  // oxlint-disable-next-line goat/react-effect-budget -- a live region's first words must arrive after it is in the page
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the region needs one empty commit in the page first.
    setPainted(true);
  }, []);
  const activity = reading ? READING : working;
  const currentDoneDuring =
    working !== null
      ? undefined
      : workOpen
        ? readingKey
        : doneDuring !== undefined && readingKey !== null && readingKey !== doneDuring
          ? undefined
          : doneDuring;
  // Words follow what the work waits on, so a wait reworded as more is known is heard once.
  const text =
    activity === null
      ? currentDoneDuring === undefined
        ? ""
        : `${botName} is done`
      : activity.state === "reading"
        ? activity.text
        : activity.wait === "you"
          ? `${botName} is waiting for you`
          : activity.wait === "usage_limit"
            ? `${botName} is paused on a usage limit`
            : `${botName} is working`;
  const [reply, setReply] = useState<{
    sequence: number;
    toggle: boolean;
    activity: string;
    clause: string;
    changes: number;
  } | null>(null);
  if (announcement !== null && announcement.sequence !== reply?.sequence) {
    const toggle = !(reply?.toggle ?? false);
    const row = announcement.row;
    const clause =
      row.tone === "question"
        ? toggle
          ? `${botName} asked a question.`
          : `New question from ${botName}.`
        : row.proactive
          ? toggle
            ? `${botName} posted an update.`
            : `New update from ${botName}.`
          : toggle
            ? `${botName} replied.`
            : `New reply from ${botName}.`;
    setReply({ sequence: announcement.sequence, toggle, activity: text, clause, changes: 0 });
  } else if (reply !== null && reply.activity !== text && reply.clause !== "") {
    setReply({
      ...reply,
      activity: text,
      clause: reading || reply.changes >= 1 ? "" : reply.clause,
      changes: reply.changes + 1,
    });
  }
  const output = reply?.clause ? [text, reply.clause].filter(Boolean).join(". ") : text;
  return (
    <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {painted ? output : ""}
    </span>
  );
}
