import * as Dialog from "../../components/ui/Dialog";
import { parseSideChatCommand } from "./sideChatCommand";

/** A thread that does not exist yet has nothing to ask about, so `/side` must not become its first message. */
export function refuseSideChatWithoutThread(text: string, queuedTask: boolean): boolean {
  if (parseSideChatCommand(text) === null) return false;
  Dialog.alert(
    "Side chat needs a thread",
    queuedTask
      ? "The queued task keeps your edit and waits until you change it."
      : "Send a first message, then ask a side question.",
  );
  return true;
}
