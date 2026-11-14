import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { useEffect, useState } from "react";
import { useGoatBotName } from "./goatBotMemberContext";

export function GoatBotReplyStatus({
  announcement,
  replyingSince,
  sends = 0,
}: {
  readonly announcement: {
    readonly sequence: number;
    readonly row: Extract<GoatBotRow, { kind: "bot" }>;
  } | null;
  readonly replyingSince: string | null;
  readonly sends?: number;
}) {
  const botName = useGoatBotName();
  const [painted, setPainted] = useState(false);
  // oxlint-disable-next-line goat/react-effect-budget -- Mount the live region empty before its first announcement.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- The first message must follow the initial empty commit.
    setPainted(true);
  }, []);
  const [reply, setReply] = useState({
    sequence: 0,
    toggle: false,
    text: "",
    readingKey: replyingSince,
    sends,
  });
  const sending =
    sends !== reply.sends || (replyingSince !== null && replyingSince !== reply.readingKey);
  if (announcement !== null && announcement.sequence !== reply.sequence) {
    const toggle = !reply.toggle;
    const row = announcement.row;
    const text =
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
    setReply({
      sequence: announcement.sequence,
      toggle,
      text: sending ? "" : text,
      readingKey: replyingSince,
      sends,
    });
  } else if (reply.readingKey !== replyingSince || reply.sends !== sends) {
    setReply({ ...reply, readingKey: replyingSince, sends, text: sending ? "" : reply.text });
  }
  return (
    <span role="status" aria-live="polite" aria-label="New bot reply" className="sr-only">
      {painted ? reply.text : ""}
    </span>
  );
}
