import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { useEffect, useState } from "react";
import { useGoatBotName } from "./goatBotMemberContext";

/**
 * The chat's reply announcement, apart from its activity status. Only a new reply writes it and
 * only a send this chat accepted clears it, so nothing else makes it speak again.
 */
export function GoatBotReplyStatus({
  announcement,
  sends = 0,
}: {
  readonly announcement: {
    readonly sequence: number;
    readonly row: Extract<GoatBotRow, { kind: "bot" }>;
  } | null;
  readonly sends?: number;
}) {
  const botName = useGoatBotName();
  const [painted, setPainted] = useState(false);
  // oxlint-disable-next-line goat/react-effect-budget -- Mount the live region empty before its first announcement.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- The first message must follow the initial empty commit.
    setPainted(true);
  }, []);
  const [reply, setReply] = useState({ sequence: 0, toggle: false, text: "", sends });
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
    setReply({ sequence: announcement.sequence, toggle, text, sends });
  } else if (reply.sends !== sends) {
    setReply({ ...reply, sends, text: "" });
  }
  return (
    <span role="status" aria-live="polite" data-goat-bot-reply-status="" className="sr-only">
      {painted ? reply.text : ""}
    </span>
  );
}
