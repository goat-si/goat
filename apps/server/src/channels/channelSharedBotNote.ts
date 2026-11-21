import type { ChannelRequester } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { ChannelLedger, ChannelStoredInput } from "./ChannelLedger.ts";
import type { ChannelBotNoteWriter } from "./channelBotNoteWriter.ts";
import { mayWriteBotNotes } from "./channelBotNoteTabEdits.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";

const REQUEST = /^remember for all bots:\s*(\S[\s\S]*)$/iu;
const CONFIRM = /^For all bots \(([\da-z:_-]{6,80})\)$/iu;
const confirmation = (id: string) => "For all bots (" + id.slice(-8) + ")";

export const isSharedBotNoteRequest = (text: string) =>
  REQUEST.test(text.trim()) || CONFIRM.test(text.trim());

export const sharedBotNoteReply = Effect.fn("channel.sharedBotNoteReply")(function* (
  stored: ChannelStoredInput,
  judged: Effect.Effect<ChannelRequester | undefined>,
  ledger: Pick<ChannelLedger["Service"], "getInput" | "readConversationTail">,
  writer: ChannelBotNoteWriter["Service"],
  at: string,
) {
  const text = stored.message.text.trim();
  if (stored.message.intent !== "message" || !isSharedBotNoteRequest(text)) return undefined;
  const allowed = judged.pipe(Effect.map((who) => who !== undefined && mayWriteBotNotes(who)));
  if (!(yield* allowed)) return { text: CHANNEL_COPY.noteEditNotAllowed };
  const inputId = stored.snapshot.inputId;
  const proposal = REQUEST.exec(text)?.[1];
  if (proposal !== undefined) {
    if (proposal.length > 500) return { text: "Use 500 characters or fewer for a shared note." };
    return {
      text: "Save this note for all bots? " + proposal,
      options: [confirmation(inputId)],
      byWord: true,
    };
  }
  const recent = yield* ledger.readConversationTail(stored.snapshot.conversationId, 48);
  const candidates = recent.filter((entry) => {
    if (entry.inputId === inputId || entry.replyText === undefined) return false;
    return (
      (REQUEST.test(entry.text.trim()) && confirmation(entry.inputId) === text) ||
      entry.text.trim() === text
    );
  });
  const matches = [];
  for (const candidate of candidates) {
    const original = yield* ledger.getInput(candidate.inputId);
    if (
      original?.requester?.principalId !== stored.requester?.principalId ||
      original?.ownerId !== stored.ownerId ||
      original.botId !== stored.botId ||
      original.message.connectionId !== stored.message.connectionId
    )
      continue;
    const note = REQUEST.exec(original.message.text.trim())?.[1];
    if (note === undefined) {
      if (original.decision?.replyText === "Saved for all bots.")
        return { text: "This shared note was already confirmed." };
    } else if (
      original.decision?.action.type === "clarify" &&
      original.decision.action.options?.includes(text)
    ) {
      matches.push({ inputId: candidate.inputId, note });
    }
  }
  const [match, duplicate] = matches;
  if (match === undefined || duplicate !== undefined)
    return {
      text: "This shared note confirmation expired. Ask to remember it for all bots again.",
    };
  const saved = yield* writer.save(match.note, at, match.inputId, undefined, undefined, allowed);
  return { text: saved.notice ?? "Saved for all bots." };
});
